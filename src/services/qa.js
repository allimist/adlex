/**
 * QA load runs: send waves of test visitors through a campaign link, optionally click a brand link
 * on the landing site, then count what adlex stored for this run.
 *
 * Modes:
 *   browser — real headless Chrome (playwright-core, installed Chrome). Every visitor gets its own
 *             browser context (isolated cookies, like an incognito window), so the website's own
 *             scripts run: landing, token filling, the brand-click beacon.
 *   http    — no browser: follow the campaign redirect and send the brand-click conversion directly.
 *             Tests adlex only, not the website's JavaScript.
 *
 * All test traffic carries ?adlex_qa=<runId>; clicks and conversions keep it as `qaRun`, which is
 * how results are counted and how the test data is deleted afterwards.
 */
import { getDb } from '../db/index.js';
import { toList, toObj } from '../db/adapter.js';
import { HttpError } from '../lib/http.js';
import { randomToken } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { getBus } from '../bus/index.js';
import { BRANDCLICK_STATUS } from './conversions.js';
import { findByHost } from './sites.js';

const col = () => getDb().collection('qa_runs');
export const MODES = [
  ['browser', 'Real browsers (headless Chrome, isolated like incognito)'],
  ['http', 'HTTP simulation (no browser, tests adlex only)'],
];
const MAX_VISITS = 1000;
const SETTLE_MS = 3000; // let the event bus flush and beacons land before counting

let active = null; // one run at a time per process

export const DEFAULTS = {
  mode: 'browser',
  visitorsPerWave: 10,
  intervalSec: 3,
  durationSec: 30,
  clickBrand: true,
  brandDelaySec: 2,
  extraParams: 'msclkid=QA-{rand}&CampaignId=qa-{n}',
};

function int(v, def, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export const START_AT = [
  ['campaign', 'Campaign link (adlex redirect flow)'],
  ['site', 'Site URL (classic flow, like db.bestoffers.biz)'],
];

export function fromBody(body) {
  return {
    startAt: body.startAt === 'site' ? 'site' : 'campaign',
    landingUrl: String(body.landingUrl || '').trim().slice(0, 500),
    campaignId: String(body.campaignId || ''),
    mode: body.mode === 'http' ? 'http' : 'browser',
    visitorsPerWave: int(body.visitorsPerWave, DEFAULTS.visitorsPerWave, 1, 50),
    intervalSec: int(body.intervalSec, DEFAULTS.intervalSec, 1, 60),
    durationSec: int(body.durationSec, DEFAULTS.durationSec, 1, 600),
    clickBrand: !!body.clickBrand,
    brandDelaySec: int(body.brandDelaySec, DEFAULTS.brandDelaySec, 0, 30),
    extraParams: String(body.extraParams || '').trim().replace(/^[?&]+/, '').slice(0, 500),
  };
}

export function plan(cfg) {
  const waves = Math.max(1, Math.floor(cfg.durationSec / cfg.intervalSec));
  return { waves, visits: waves * cfg.visitorsPerWave };
}

export function isRunning() {
  return !!active;
}

export async function listRuns(limit = 20) {
  return toList(await col().get())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/** On startup: runs left 'running' by a stopped/crashed process can never finish. */
export async function markInterrupted() {
  const stale = toList(await col().get()).filter((r) => r.status === 'running' || r.status === 'counting');
  for (const r of stale) {
    await col().doc(r.id).update({ status: 'failed', error: 'adlex was restarted while this run was in progress', finishedAt: Date.now() });
  }
  return stale.length;
}

export async function getRun(id) {
  return toObj(await col().doc(id).get());
}

export async function startRun(body) {
  if (active) throw new HttpError(409, 'A QA run is already in progress. Wait for it to finish.');
  const cfg = fromBody(body);
  let target;
  if (cfg.startAt === 'site') {
    // Classic flow: visitors open the site directly; its session.js asks adlex /se/ for the clickid.
    let u = null;
    try {
      u = new URL(cfg.landingUrl);
    } catch {
      // handled below
    }
    if (!u || !/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Enter the site URL to open, e.g. http://localhost:4110/weightloss');
    if (!(await findByHost(u.hostname))) throw new HttpError(400, `${u.hostname} is not under Sites: adlex would reject its /se/ and /pc/ requests`);
    target = { campaignName: u.host + u.pathname, campaignKey: '' };
  } else {
    const campaign = cfg.campaignId ? toObj(await getDb().collection('campaigns').doc(cfg.campaignId).get()) : null;
    if (!campaign) throw new HttpError(400, 'Choose a campaign');
    if (campaign.status !== 'active') throw new HttpError(400, 'The campaign is not active');
    target = { campaignName: campaign.name, campaignKey: campaign.key };
  }
  const { waves, visits } = plan(cfg);
  if (visits > MAX_VISITS) throw new HttpError(400, `At most ${MAX_VISITS} visits per run (this would be ${visits})`);

  const id = 'qa_' + randomToken(8);
  const now = Date.now();
  const run = {
    ...cfg,
    ...target,
    waves,
    planned: visits,
    status: 'running',
    progress: emptyProgress(),
    errorsSample: [],
    createdAt: now,
    startedAt: now,
  };
  await col().doc(id).set(run);
  active = execute(id, run)
    .catch(async (err) => {
      logger.error({ msg: 'qa run failed', id, err: String(err) });
      await col().doc(id).update({ status: 'failed', error: String(err.message || err).slice(0, 500), finishedAt: Date.now() });
    })
    .finally(() => {
      active = null;
    });
  return id;
}

function emptyProgress() {
  return { started: 0, landed: 0, landedWithSe: 0, linksFilled: 0, brandClicked: 0, brandReported: 0, errors: 0 };
}

/**
 * First URL for visitor n: the campaign link, or the site URL in classic mode, plus the extra params
 * ({rand} = random, {n} = visitor number) and the run tag (the site's session.js forwards it to /se/).
 */
export function visitUrl(run, id, n) {
  const extra = run.extraParams.replace(/\{rand\}/g, () => randomToken(4)).replace(/\{n\}/g, String(n));
  const qs = [extra, `adlex_qa=${encodeURIComponent(id)}`].filter(Boolean).join('&');
  if (run.startAt === 'site') return run.landingUrl + (run.landingUrl.includes('?') ? '&' : '?') + qs;
  return `${config.baseUrl}/click/${run.campaignKey}?${qs}`;
}

/** The site's brand-click report: adlex flow (/postback?status=brandclick) or classic (/pc/?event_type=brandclick). */
function isBrandReport(url) {
  return (url.includes('/postback') && url.includes('status=brandclick')) || (url.includes('/pc/') && url.includes('event_type=brandclick'));
}

async function execute(id, run) {
  const p = run.progress;
  const errors = [];
  const noteError = (err) => {
    p.errors++;
    if (errors.length < 10) errors.push(String(err && err.message ? err.message : err).split('\n')[0].slice(0, 200));
  };
  const saver = setInterval(() => col().doc(id).update({ progress: { ...p }, errorsSample: errors }).catch(() => {}), 1000);

  let browser = null;
  try {
    if (run.mode === 'browser') browser = await launchBrowser();
    const visit = run.mode === 'browser' ? (n) => visitBrowser(browser, visitUrl(run, id, n), run, p) : (n) => visitHttp(visitUrl(run, id, n), run, p);

    const all = [];
    let n = 0;
    for (let w = 0; w < run.waves; w++) {
      const waveAt = run.startedAt + w * run.intervalSec * 1000;
      const wait = waveAt - Date.now();
      if (wait > 0) await sleep(wait);
      for (let i = 0; i < run.visitorsPerWave; i++) {
        const num = ++n;
        p.started++;
        all.push(visit(num).catch(noteError));
      }
    }
    await Promise.all(all);
  } finally {
    if (browser) await browser.close().catch(() => {});
    clearInterval(saver);
  }

  await col().doc(id).update({ status: 'counting', progress: { ...p }, errorsSample: errors });
  await sleep(SETTLE_MS);
  await getBus().flush?.();
  const results = await countResults(id);
  await col().doc(id).update({ status: 'done', progress: { ...p }, errorsSample: errors, results, finishedAt: Date.now() });
}

async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('Browser mode needs playwright-core (npm i playwright-core) — or use HTTP mode.');
  }
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch (err) {
    throw new Error('Could not start Google Chrome on this server (' + String(err.message).split('\n')[0] + '). Use HTTP mode here.');
  }
}

/** Only adlex itself and registered Sites are reachable: offer links to affiliate networks are blocked. */
async function allowedHost(hostname, adlexHost) {
  if (hostname === adlexHost) return true;
  return !!(await findByHost(hostname));
}

async function visitBrowser(browser, url, run, p) {
  const adlexHost = new URL(config.baseUrl).hostname;
  const context = await browser.newContext(); // fresh cookies/storage: an incognito window
  try {
    await context.route('**/*', async (route) => {
      let host = '';
      try {
        host = new URL(route.request().url()).hostname;
      } catch {
        // data: / blob: urls
      }
      if (!host || (await allowedHost(host, adlexHost))) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    // Classic flow: the clickid comes from the site's own /se/ request, not from the landing URL.
    const sessionReply =
      run.startAt === 'site' ? page.waitForResponse((r) => new URL(r.url()).pathname.replace(/\/$/, '') === '/se', { timeout: 20000 }) : null;
    if (sessionReply) sessionReply.catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    p.landed++;
    let se = new URL(page.url()).searchParams.get('se') || '';
    if (sessionReply) {
      try {
        const r = await sessionReply;
        const body = (await r.text()).trim();
        if (r.status() >= 400) throw new Error(`adlex /se/ answered ${r.status()} ${body.slice(0, 60)}`);
        se = body;
      } catch (err) {
        throw new Error(err.message.startsWith('adlex') ? err.message : 'the site did not call adlex /se/ within 20s');
      }
    }
    if (se) p.landedWithSe++;
    if (!run.clickBrand) return;

    await page.waitForTimeout(run.brandDelaySec * 1000);
    // Brand links the visitor can actually see (layouts keep hidden duplicates for other screen sizes)
    const links = page.locator('a[href*="brand="]:visible');
    try {
      await links.first().waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      // Say what the page looked like, so a failed visit can be told apart from a tracking problem
      const state = await page
        .evaluate(() => ({
          ready: document.readyState,
          brandLinks: document.querySelectorAll('a[href*="brand="]').length,
          skeletons: document.querySelectorAll('.skeleton').length,
          path: location.pathname,
        }))
        .catch(() => null);
      throw new Error(`no visible brand link after 20s (page ${state ? JSON.stringify(state) : 'not readable'})`);
    }
    // Pick a product at random, then one of its links: products with several links aren't favoured
    const brands = await links.evaluateAll((els) => els.map((a) => new URL(a.href).searchParams.get('brand') || ''));
    const products = [...new Set(brands)];
    const product = products[Math.floor(Math.random() * products.length)];
    const choices = brands.map((b, i) => (b === product ? i : -1)).filter((i) => i >= 0);
    const link = links.nth(choices[Math.floor(Math.random() * choices.length)]);
    // adlex flow fills link tokens after load; the classic brand-click.js fills them only at click time
    if (run.startAt !== 'site') {
      const href = (await link.getAttribute('href')) || '';
      if (!/\{[^}]+\}|%7B/i.test(href) && (!se || href.includes(se))) p.linksFilled++;
    }

    // Wait until the site's own brand-click report leaves the browser, instead of a fixed pause:
    // closing the browser too early would drop a report a real visitor's browser still sends.
    // Whether adlex stored it is checked against the database at the end of the run.
    const report = context.waitForEvent('request', { predicate: (r) => isBrandReport(r.url()), timeout: 15000 });
    // If the click below fails, the context closes and this wait rejects with nobody awaiting it:
    // mark it handled so it can't become an unhandled rejection.
    report.catch(() => {});
    // Don't let the click itself decide success: the classic brand-click.js sends its report with a
    // synchronous request that freezes the page, so the click action can time out even though the
    // report went out. The report arriving is what counts.
    let clickError = null;
    const clicking = link.click({ noWaitAfter: true, timeout: 15000 }).catch((err) => {
      clickError = err;
    });
    try {
      await report;
    } catch {
      await clicking;
      throw new Error(clickError ? `could not click the brand link (${String(clickError.message).split('\n')[0]})` : 'the site did not send the brand click report within 15s');
    }
    p.brandClicked++;
    await page.waitForTimeout(300); // let the request finish before the context closes
    p.brandReported++;
  } finally {
    await context.close().catch(() => {});
  }
}

const HTTP_BRANDS = ['qa-brand-a', 'qa-brand-b', 'qa-brand-c'];

async function visitHttp(url, run, p) {
  if (run.startAt === 'site') return visitHttpClassic(url, run, p);
  const res = await fetch(url, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (res.status !== 302 || !location) throw new Error(`campaign link answered ${res.status}`);
  p.landed++;
  const landing = new URL(location);
  const se = landing.searchParams.get('se') || '';
  if (se) p.landedWithSe++;
  if (!run.clickBrand) return;
  if (!se) throw new Error('landing URL has no se (turn on "Append tracking" on the offer)');
  await sleep(run.brandDelaySec * 1000);
  const brand = HTTP_BRANDS[Math.floor(Math.random() * HTTP_BRANDS.length)];
  const q = new URLSearchParams({ clickid: se, status: BRANDCLICK_STATUS, brand, link_type: 'qa' });
  const r = await fetch(`${config.baseUrl}/postback?${q}`, { method: 'POST', headers: { origin: landing.origin } });
  p.brandClicked++;
  if (r.status >= 400) throw new Error(`brand click postback answered ${r.status} ${(await r.text()).slice(0, 60)}`);
  p.brandReported++;
}

/** Classic flow without a browser: the requests the original session.js and brand-click.js make. */
async function visitHttpClassic(url, run, p) {
  const landing = new URL(url);
  const headers = { origin: landing.origin, referer: url };
  const params = new URLSearchParams(landing.search);
  params.set('page_url', landing.pathname.replace(/^\/|\/$/g, ''));
  const r1 = await fetch(`${config.baseUrl}/se/?${params}`, { headers });
  const se = (await r1.text()).trim();
  if (r1.status >= 400) throw new Error(`adlex /se/ answered ${r1.status} ${se.slice(0, 60)}`);
  p.landed++;
  p.landedWithSe++;
  if (!run.clickBrand) return;
  await sleep(run.brandDelaySec * 1000);
  const brand = HTTP_BRANDS[Math.floor(Math.random() * HTTP_BRANDS.length)];
  const q = new URLSearchParams({ record_source: 'site', event_type: BRANDCLICK_STATUS, brand, link_type: 'qa', event_id: se });
  const r2 = await fetch(`${config.baseUrl}/pc/?${q}`, { headers });
  p.brandClicked++;
  if (r2.status >= 400) throw new Error(`/pc/ brand click answered ${r2.status} ${(await r2.text()).slice(0, 60)}`);
  p.brandReported++;
}

async function countResults(id) {
  const db = getDb();
  const clicks = toList(await db.collection('clicks').where('qaRun', '==', id).get());
  const convs = toList(await db.collection('conversions').where('qaRun', '==', id).get());
  const clickIds = new Set(clicks.map((c) => c.id));
  const pending = toList(await db.collection('pending_conversions').where('state', '==', 'pending').get()).filter((x) =>
    clickIds.has(x.params && x.params.clickid),
  );
  const brandConvs = convs.filter((c) => c.status === BRANDCLICK_STATUS);
  const byBrand = {};
  for (const c of brandConvs) byBrand[c.brand || '(none)'] = (byBrand[c.brand || '(none)'] || 0) + 1;
  return {
    byBrand,
    clicks: clicks.length,
    clicksWithAdClickId: clicks.filter((c) => c.adClickId).length,
    brandClickConversions: brandConvs.length,
    clicksWithBrandClick: new Set(brandConvs.map((c) => c.clickId)).size,
    otherConversions: convs.length - brandConvs.length,
    pendingBrandClicks: pending.length,
  };
}

/** Delete everything a run created (clicks, conversions, queued postbacks) and the run itself. */
export async function deleteRun(id) {
  if (active && (await getRun(id))?.status === 'running') throw new HttpError(409, 'The run is still in progress');
  const db = getDb();
  const refs = [];
  const clicks = await db.collection('clicks').where('qaRun', '==', id).get();
  clicks.forEach((d) => refs.push(db.collection('clicks').doc(d.id)));
  const ids = new Set(clicks.docs.map((d) => d.id));
  (await db.collection('conversions').where('qaRun', '==', id).get()).forEach((d) => refs.push(db.collection('conversions').doc(d.id)));
  (await db.collection('pending_conversions').get()).forEach((d) => {
    if (ids.has(d.data().params?.clickid)) refs.push(db.collection('pending_conversions').doc(d.id));
  });
  refs.push(col().doc(id));
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }
  return refs.length - 1;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
