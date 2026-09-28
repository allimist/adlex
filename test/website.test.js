import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adlex-web-'));
process.env.LOG_CLICKS = '0';
process.env.BUS_DRIVER = 'direct';
process.env.BUS_FLUSH_MS = '20';
process.env.SESSION_SECRET = 'test-secret-test-secret';
process.env.LEGACY_REPORT_CODE = 'dumpcode1';

const { getDb } = await import('../src/db/index.js');
const { applyEvents } = await import('../src/services/ingest.js');
const { DirectBus } = await import('../src/bus/direct.js');
const { getBus } = await import('../src/bus/index.js');
const sites = await import('../src/services/sites.js');
const { recordConversion, retryPending, isRecentClickId, ulidTime } = await import('../src/services/conversions.js');
const exportsSvc = await import('../src/services/exports.js');
const { ulid } = await import('../src/lib/ids.js');
const { createApp } = await import('../src/app.js');

const db = getDb();
let server;
let base;

before(async () => {
  await db.collection('sources').doc('web').set({
    name: 'Web',
    costModel: 'none',
    status: 'active',
    postbackToken: 'tok',
    params: { clickid: { name: 'clickid', token: '' }, cost: { name: 'cost', token: '' }, t1: { name: 'campaignid', token: '' } },
  });
  await sites.addMany({ domains: 'https://www.Example.com/landing\nlocalhost\nnot a domain!', sourceId: 'web' });
  await getBus().startConsumer(applyEvents);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await getBus().close();
  await db.close();
});

test('normalizeDomain and bulk add', async () => {
  assert.equal(sites.normalizeDomain('HTTPS://www.Shop.Example.com:8443/x?y'), 'shop.example.com');
  assert.equal(sites.normalizeDomain('bad domain'), '');
  assert.ok(await sites.getById('example.com'));
  const r = await sites.addMany({ domains: 'example.com, new-site.net', sourceId: 'web' });
  assert.deepEqual(r.added, ['new-site.net']);
  assert.deepEqual(r.skipped, ['example.com']);
});

test('findByHost matches parent domains, never a bare TLD', async () => {
  assert.equal((await sites.findByHost('lp.example.com')).id, 'example.com');
  assert.equal(await sites.findByHost('example.org'), null);
  assert.equal(await sites.findByHost('com'), null);
});

test('applyEvents is idempotent and outclicks update their click', async () => {
  const id = ulid();
  const click = { type: 'click', id, clickId: id, data: { createdAt: 1, sourceId: 'web', converted: false, revenue: 0, outclicks: 0 } };
  const oc = (bid, brand, createdAt) => ({ type: 'outclick', id: bid, clickId: id, brand, createdAt });
  let r = await applyEvents([click, oc('o1', 'trim', 10)]);
  assert.deepEqual([r.clicks, r.outclicks], [1, 1]);
  r = await applyEvents([click, oc('o1', 'trim', 10), oc('o2', 'medvi', 20)]); // redelivery + one new
  assert.deepEqual([r.clicks, r.outclicks, r.skipped], [0, 1, 2]);
  const c = (await db.collection('clicks').doc(id).get()).data();
  assert.equal(c.outclicks, 2);
  assert.equal(c.lastBrand, 'medvi');
});

test('DirectBus flushes on batch size and on timer, retries on failure', async () => {
  const got = [];
  let fail = true;
  const bus = new DirectBus({ flushMs: 10, batchSize: 3, logger: { error() {} } });
  await bus.startConsumer(async (ev) => {
    if (fail) {
      fail = false;
      throw new Error('db down');
    }
    got.push(...ev);
  });
  bus.publish(1);
  bus.publish(2);
  bus.publish(3); // size-triggered flush fails, events go back to the buffer
  await new Promise((r) => setTimeout(r, 50));
  bus.publish(4);
  await bus.close();
  assert.deepEqual(got.sort(), [1, 2, 3, 4]);
});

test('/se/ returns a clickid with CORS for known sites, 403 for unknown', async () => {
  let res = await fetch(`${base}/se/?gclid=G-1&campaignid=555&page_url=weightloss`, { headers: { origin: 'https://lp.example.com' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://lp.example.com');
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  const id = await res.text();
  assert.ok(isRecentClickId(id));

  await getBus().flush(); // the click must be stored before a brand-click conversion can attach to it
  res = await fetch(`${base}/pc/?record_source=site&event_type=brandclick&event_id=${id}&brand=trim&gclid=G-1&source=gclid`, { headers: { origin: 'https://example.com' } });
  assert.equal(await res.text(), 'OK');

  res = await fetch(`${base}/se/`, { headers: { origin: 'https://evil.test' } });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);

  await getBus().flush();
  const c = (await db.collection('clicks').doc(id).get()).data();
  assert.equal(c.siteId, 'example.com');
  assert.equal(c.domain, 'lp.example.com');
  assert.equal(c.adClickType, 'gclid');
  assert.equal(c.adClickId, 'G-1');
  assert.equal(c.t1, '555');
  assert.equal(c.pageUrl, 'weightloss');
  assert.equal(c.lastBrand, 'trim');
});

test('postback before the click is stored is queued, then applied', async () => {
  const id = ulid();
  assert.equal(ulidTime(id) <= Date.now(), true);
  let r = await recordConversion({ clickid: id, payout: '40', status: 'sale', token: 'tok' });
  assert.equal(r.text, 'QUEUED');
  await applyEvents([{ type: 'click', id, data: { createdAt: Date.now(), day: '2026-01-01', sourceId: 'web', siteId: 'example.com', adClickId: 'MS-1', adClickType: 'msclkid', converted: false, revenue: 0 } }]);
  r = await retryPending();
  assert.equal(r.done, 1);
  const cv = (await db.collection('conversions').doc('cv_' + id).get()).data();
  assert.equal(cv.payout, 40);
  assert.equal(cv.adClickId, 'MS-1');
  // bad token on a website click (source token) is refused
  assert.equal((await recordConversion({ clickid: id, payout: 1, token: 'nope' })).code, 403);
  // stale or foreign ids are not queued
  assert.equal((await recordConversion({ clickid: ulid(Date.now() - 3600000) })).code, 404);
});

test('export windows', () => {
  const now = Date.UTC(2026, 2, 15, 12); // 2026-03-15 12:00Z
  assert.deepEqual(exportsSvc.windowRange({ windowType: 'rolling', windowDays: 2 }, now), { from: now - 2 * 86400000, to: now + 1 });
  const prev = exportsSvc.windowRange({ windowType: 'monthly', month: 'previous', utcOffset: '+0000' }, now);
  assert.deepEqual(prev, { from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 2, 1) });
  const jan = exportsSvc.windowRange({ windowType: 'monthly', month: 'previous', utcOffset: '-0500' }, Date.UTC(2026, 0, 10));
  assert.equal(jan.from, Date.UTC(2025, 11, 1) + 5 * 3600000);
  assert.equal(exportsSvc.fmtTime(Date.UTC(2026, 0, 1, 3, 4, 5), '-0500'), '2025-12-31 22:04:05');
});

test('Google / Microsoft CSV rows, payout on and off', async () => {
  const now = Date.now();
  const conv = (id, adClickType, adClickId, status = 'sale') =>
    db.collection('conversions').doc(id).set({ createdAt: now - 3600000, day: '2026-01-01', clickId: 'C' + id, clickCreatedAt: now - 7200000, sourceId: 'web', siteId: 'example.com', status, payout: 12.5, adClickType, adClickId });
  await conv('g1', 'gclid', 'GCL,1');
  await conv('g2', 'gclid', 'GCL2', 'rejected');
  await conv('m1', 'msclkid', 'MSC1');
  const g = { platform: 'google_ads', conversionName: 'Sale', includePayout: true, currency: 'USD', utcOffset: '+0000', windowType: 'rolling', windowDays: 2, statuses: [], sourceIds: [], siteIds: [] };
  const out = (await exportsSvc.toCsv(g)).csv.split('\r\n');
  assert.equal(out[0], 'Parameters:TimeZone=+0000');
  assert.equal(out[1], 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency,Order ID');
  assert.ok(out.some((l) => l.startsWith('"GCL,1",Sale,') && l.endsWith(',12.50,USD,g1')));
  assert.ok(!out.some((l) => l.includes('GCL2'))); // rejected excluded
  assert.ok(!out.some((l) => l.includes('MSC1'))); // other platform excluded
  const m = (await exportsSvc.toCsv({ ...g, platform: 'microsoft_ads', includePayout: false })).csv.split('\r\n');
  assert.equal(m[1], 'Microsoft Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency');
  assert.ok(m.some((l) => /^MSC1,Sale,\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,,$/.test(l)));
  const old = (await exportsSvc.toCsv({ ...g, windowType: 'monthly', month: 'previous' }, { now: now + 40 * 86400000 })).rows;
  assert.equal(typeof old, 'number');
});

test('custom export renders macros and guards formulas', async () => {
  const c = { platform: 'custom', customColumns: 'Id={clickid}\nWhen={conversion_time}\nX==1+1', includePayout: true, utcOffset: '+0000', windowType: 'rolling', windowDays: 2, statuses: ['sale'], sourceIds: [], siteIds: [] };
  const lines = (await exportsSvc.toCsv(c)).csv.split('\r\n');
  assert.equal(lines[0], 'Id,When,X');
  assert.ok(lines.some((l) => l.startsWith('Cg1,') && l.endsWith(",'=1+1")));
});

test('appendTracking adds se, t params and ad click id, keeps existing params', async () => {
  const { appendTracking } = await import('../src/services/tracking.js');
  const url = appendTracking('https://site.test/p?x=1', { id: 'CID1', t1: '77', t3: 'kw', adClickType: 'msclkid', adClickId: 'MS1' });
  const u = new URL(url);
  assert.deepEqual([u.searchParams.get('x'), u.searchParams.get('se'), u.searchParams.get('t1'), u.searchParams.get('t2'), u.searchParams.get('t3'), u.searchParams.get('msclkid')], ['1', 'CID1', '77', null, 'kw', 'MS1']);
  assert.equal(new URL(appendTracking('https://s.test/', { id: 'A' }, 'cid')).searchParams.get('cid'), 'A');
  assert.equal(appendTracking('not a url', { id: 'A' }), 'not a url');
});

test('/click/:key redirect: msclkid stored, lp only for registered sites, tracking appended', async () => {
  await db.collection('offers').doc('lp1').set({ name: 'Landing', url: 'https://example.com/weightloss?a=1', payout: 0, status: 'active', appendTracking: true, trackingParam: 'se' });
  await db.collection('campaigns').doc('cbing').set({ name: 'Bing', key: 'bingkey1', sourceId: 'web', offers: [{ offerId: 'lp1', weight: 100 }], status: 'active', allowLp: true, postbackToken: '' });
  const go = async (qs) => {
    const res = await fetch(`${base}/click/bingkey1?${qs}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    return new URL(res.headers.get('location'));
  };
  let loc = await go('msclkid=MS-9&campaignid=77&lp=' + encodeURIComponent('https://lp.example.com/glp?b=2'));
  assert.equal(loc.origin + loc.pathname, 'https://lp.example.com/glp');
  assert.equal(loc.searchParams.get('b'), '2');
  assert.equal(loc.searchParams.get('t1'), '77');
  assert.equal(loc.searchParams.get('msclkid'), 'MS-9');
  const se = loc.searchParams.get('se');
  assert.ok(isRecentClickId(se));

  loc = await go('lp=' + encodeURIComponent('https://evil.test/phish'));
  assert.equal(loc.hostname, 'example.com'); // unregistered lp falls back to the offer URL
  assert.equal(loc.searchParams.get('a'), '1');

  await getBus().flush();
  const c = (await db.collection('clicks').doc(se).get()).data();
  assert.equal(c.adClickType, 'msclkid');
  assert.equal(c.adClickId, 'MS-9');
  assert.equal(c.campaignId, 'cbing');
});

test('brand click conversion: only from registered sites, no token, one per brand, reported apart from sales', async () => {
  const id = ulid();
  await applyEvents([{ type: 'click', id, data: { createdAt: Date.now(), day: '2026-01-01', sourceId: 'web', campaignId: '', converted: false, revenue: 0, outclicks: 0 } }]);
  const send = (qs, origin) => fetch(`${base}/postback?${qs}`, { method: 'POST', headers: origin ? { origin } : {} });

  let res = await send(`clickid=${id}&status=brandclick&brand=trim`, 'https://evil.test');
  assert.equal(res.status, 403);
  res = await send(`clickid=${id}&status=brandclick&brand=trim&link_type=cta&payout=99`, 'https://example.com');
  assert.equal(await res.text(), 'OK');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.com');
  assert.equal(await (await send(`clickid=${id}&status=brandclick&brand=trim`, 'https://example.com')).text(), 'DUPLICATE');
  assert.equal(await (await send(`clickid=${id}&status=brandclick&brand=medvi`, 'https://example.com')).text(), 'OK');

  const convs = toListLocal((await db.collection('conversions').where('clickId', '==', id).get()));
  assert.equal(convs.length, 2);
  assert.ok(convs.every((c) => c.status === 'brandclick' && c.payout === 0));
  assert.deepEqual(convs.map((c) => c.brand).sort(), ['medvi', 'trim']);
  const click = (await db.collection('clicks').doc(id).get()).data();
  assert.equal(click.outclicks, 2);
  assert.equal(click.converted, false); // brand clicks don't mark the click as a sale

  // a real sale still needs the source token, and is counted separately in reports
  assert.equal((await recordConversion({ clickid: id, status: 'sale', payout: 30 })).code, 403);
  assert.equal((await recordConversion({ clickid: id, status: 'sale', payout: 30, token: 'tok' })).text, 'OK');
  const { aggregate } = await import('../src/services/reports.js');
  const { total } = await aggregate({ from: 0, to: Date.now() + 1000, groupBy: 'sourceId', filter: { sourceId: 'web' } });
  assert.ok(total.brandClicks >= 2);
  const g = { platform: 'google_ads', conversionName: 'S', includePayout: true, currency: 'USD', utcOffset: '+0000', windowType: 'rolling', windowDays: 2, statuses: [], sourceIds: [], siteIds: [] };
  assert.ok(!(await exportsSvc.toCsv({ ...g, platform: 'custom', customColumns: 'S={status}' })).csv.includes('brandclick'));
  assert.ok((await exportsSvc.toCsv({ ...g, platform: 'custom', customColumns: 'S={status}', statuses: ['brandclick'] })).csv.includes('brandclick'));
});

function toListLocal(qs) {
  return qs.docs.map((d) => ({ id: d.id, ...d.data() }));
}

test('QA helpers: plan, input limits, run tag', async () => {
  const qa = await import('../src/services/qa.js');
  const { qaTag } = await import('../src/services/tracking.js');
  assert.deepEqual(qa.plan({ visitorsPerWave: 10, intervalSec: 3, durationSec: 30 }), { waves: 10, visits: 100 });
  assert.deepEqual(qa.plan({ visitorsPerWave: 2, intervalSec: 5, durationSec: 3 }), { waves: 1, visits: 2 });
  const cfg = qa.fromBody({ visitorsPerWave: 999, intervalSec: 0, durationSec: 'x', mode: 'weird', extraParams: '?a=1' });
  assert.deepEqual([cfg.visitorsPerWave, cfg.intervalSec, cfg.durationSec, cfg.mode, cfg.extraParams], [50, 1, 30, 'browser', 'a=1']);
  assert.equal(cfg.startAt, 'campaign');
  const site = new URL(qa.visitUrl({ startAt: 'site', landingUrl: 'http://localhost:4110/weightloss', extraParams: 'msclkid=X{n}' }, 'qa_abc123', 3));
  assert.equal(site.origin + site.pathname, 'http://localhost:4110/weightloss');
  assert.equal(site.searchParams.get('msclkid'), 'X3');
  assert.equal(site.searchParams.get('adlex_qa'), 'qa_abc123');
  const url = new URL(qa.visitUrl({ campaignKey: 'k1', extraParams: 'msclkid=QA-{rand}&n={n}' }, 'qa_abc123', 7));
  assert.equal(url.pathname, '/click/k1');
  assert.equal(url.searchParams.get('n'), '7');
  assert.equal(url.searchParams.get('adlex_qa'), 'qa_abc123');
  assert.match(url.searchParams.get('msclkid'), /^QA-[0-9a-f]{8}$/);
  assert.deepEqual(qaTag({ adlex_qa: 'qa_abc123' }), { qaRun: 'qa_abc123' });
  assert.deepEqual(qaTag({ adlex_qa: 'x<script>' }), {});
});

test('rate limit exemption only for direct local requests', async () => {
  const { isLocalDirect } = await import('../src/services/collect.js');
  const req = (ip, xff) => ({ socket: { remoteAddress: ip }, get: (h) => (h === 'x-forwarded-for' ? xff : undefined) });
  assert.equal(isLocalDirect(req('::1')), true);
  assert.equal(isLocalDirect(req('127.0.0.1')), true);
  assert.equal(isLocalDirect(req('127.0.0.1', '8.8.8.8')), false); // proxied traffic is still limited
  assert.equal(isLocalDirect(req('10.0.0.5')), false);
});

test('hideInUrl: parameter stays readable but is left out of the campaign URL', async () => {
  const { paramsFromBody } = await import('../src/services/sources.js');
  const { buildClickUrl } = await import('../src/services/campaigns.js');
  const params = paramsFromBody({ param_name_clickid: 'msclkid', param_token_clickid: '{msclkid}', param_hide_clickid: '1', param_name_t1: 'CampaignId', param_token_t1: '{CampaignId}' });
  assert.equal(params.clickid.hideInUrl, true);
  assert.equal(params.t1.hideInUrl, false);
  const url = buildClickUrl({ key: 'k9', allowLp: true }, { params });
  assert.ok(!url.includes('msclkid'));
  assert.ok(url.includes('lp={lpurl}') && url.includes('CampaignId={CampaignId}'));
  const { readMappedParams } = await import('../src/services/tracking.js');
  assert.equal(readMappedParams({ msclkid: 'MS1' }, { params }).externalId, 'MS1'); // still read on /click
});

test('db.bestoffers.biz compatibility: /pc/ postbacks, /pc/up feed, /se/export and /pc/export', async () => {
  // a website click, as session.js would create it through /se/
  const res0 = await fetch(`${base}/se/?msclkid=MS-LEG&campaignid=777&page_url=weightloss`, { headers: { origin: 'https://example.com' } });
  const id = await res0.text();
  await getBus().flush();

  // brand click from the original brand-click.js
  const bc = await fetch(`${base}/pc/?record_source=site&event_type=brandclick&brand=Hone&link_type=cta&gclid=MS-LEG&event_id=${id}`, { headers: { origin: 'https://example.com' } });
  assert.equal(await bc.text(), 'OK');
  // network postback, server to server (no Origin); the source has a postback token
  assert.equal((await fetch(`${base}/pc/?event_id=${id}&revenue=45&brand=Hone`)).status, 403);
  assert.equal(await (await fetch(`${base}/pc/?event_id=${id}&revenue=45&brand=Hone&token=tok`)).text(), 'OK');
  assert.equal(await (await fetch(`${base}/pc/?event_id=${id}&revenue=12&event_name=offline_sale&txid=T2&token=tok`)).text(), 'OK');
  const convs = toListLocal(await db.collection('conversions').where('clickId', '==', id).get());
  const sales = convs.filter((c) => c.status === 'sale');
  assert.equal(sales.length, 2);
  assert.deepEqual(sales.map((c) => c.payout).sort((a, b) => a - b), [12, 45]);
  assert.ok(sales.some((c) => c.eventName === 'offline_sale'));
  assert.equal(convs.filter((c) => c.status === 'brandclick').length, 1);

  // /pc/up/?code= — the legacy offline-conversion feed
  await exportsSvc.create({ name: 'Legacy feed', platform: 'legacy_pcup', enabled: '1', includePayout: '1', currency: 'USD', windowDays: 2, conversionName: 'offline_conversions', brandNames: 'Hone=offline_leads', legacyCode: 'upcode77' });
  await assert.rejects(exportsSvc.create({ name: 'Dup', platform: 'legacy_pcup', legacyCode: 'upcode77' }), /already used/);
  assert.equal(await (await fetch(`${base}/pc/up/?code=wrong`)).text(), 'Access denied.');
  const up = await fetch(`${base}/pc/up/?code=upcode77`);
  assert.equal(up.headers.get('content-type'), 'text/csv; charset=utf-8');
  const lines = (await up.text()).trim().split('\r\n');
  assert.equal(lines[0], 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Currency Code');
  const mine = lines.filter((l) => l.startsWith('MS-LEG,'));
  assert.equal(mine.length, 2); // the two sales, never the brand click
  assert.ok(mine.some((l) => /^MS-LEG,offline_leads,\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\+0000,45\.00,USD$/.test(l)));
  assert.ok(mine.some((l) => /^MS-LEG,offline_sale,.*,12\.00,USD$/.test(l))); // event_name wins over the brand rule

  // raw dumps
  assert.equal(await (await fetch(`${base}/se/export?code=nope`)).text(), 'Access denied.');
  const se = (await (await fetch(`${base}/se/export?code=dumpcode1&date_from=2000-01-01`)).text()).trim().split('\n');
  assert.equal(se[0], 'id,date,gclid,campaignid,page_url,adgroupid,keyword,device,source');
  assert.ok(se.some((l) => l.startsWith(`${id},`) && l.includes(',MS-LEG,777,weightloss,')));
  const pc = (await (await fetch(`${base}/pc/export?code=dumpcode1`)).text()).trim().split('\n');
  assert.equal(pc[0], 'id,created_at,record_source,event_type,event_name,event_id,date,brand,revenue,gclid,campaignid,page_url,adgroupid,keyword,source,device');
  assert.ok(pc.some((l) => l.includes(`,site,brandclick,,${id},`)));
  assert.ok(pc.some((l) => l.includes(`,postback,sale,offline_sale,${id},`)));
  const future = (await (await fetch(`${base}/pc/export?code=dumpcode1&date_from=2999-01-01`)).text()).trim().split('\n');
  assert.equal(future.length, 1); // header only
});

test('/se/ with ?click=<campaign key> attributes the landing to that campaign', async () => {
  await db.collection('sources').doc('bingsrc').set({ name: 'Bing', costModel: 'none', status: 'active', params: { clickid: { name: 'msclkid', token: '' }, t1: { name: 'CampaignId', token: '' } } });
  await db.collection('offers').doc('lpc').set({ name: 'LP classic', url: 'https://example.com/weightloss', payout: 0, status: 'active' });
  await db.collection('campaigns').doc('cclassic').set({ name: 'Classic Bing', key: 'classic77', sourceId: 'bingsrc', offers: [{ offerId: 'lpc', weight: 100 }], status: 'active', postbackToken: 'camptok' });
  const open = async (qs) => (await fetch(`${base}/se/?${qs}`, { headers: { origin: 'https://example.com' } })).text();

  const id = await open('click=classic77&msclkid=MS-C&CampaignId=555&page_url=weightloss');
  const plain = await open('click=nosuchkey&msclkid=MS-D');
  await getBus().flush();
  const c = (await db.collection('clicks').doc(id).get()).data();
  assert.deepEqual([c.campaignId, c.campaignKey, c.sourceId, c.offerId, c.siteId], ['cclassic', 'classic77', 'bingsrc', 'lpc', 'example.com']);
  assert.equal(c.t1, '555'); // mapped through the campaign's source, not the site's
  assert.equal(c.externalId, 'MS-C');
  const p = (await db.collection('clicks').doc(plain).get()).data();
  assert.deepEqual([p.campaignId, p.sourceId], ['', 'web']); // unknown key: plain site click

  // conversions for this click use the campaign's postback token
  assert.equal((await recordConversion({ clickid: id, payout: 10, token: 'tok' })).code, 403);
  assert.equal((await recordConversion({ clickid: id, payout: 10, token: 'camptok' })).text, 'OK');
  const { aggregate } = await import('../src/services/reports.js');
  const { total } = await aggregate({ from: 0, to: Date.now() + 1000, groupBy: 'campaignId', filter: { campaignId: 'cclassic' } });
  assert.equal(total.clicks, 1);
  assert.equal(total.conversions, 1);
});
