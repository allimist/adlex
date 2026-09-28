/**
 * Offline-conversion CSV exports for ad platforms (Google Ads, Microsoft Advertising) or any custom layout.
 * Each export has a window (rolling N days, or the current/previous calendar month) and a secret URL
 * that the platform's scheduled import fetches: GET /x/<token>.csv (optionally behind basic auth).
 */
import { timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/index.js';
import { toList, toObj } from '../db/adapter.js';
import { HttpError } from '../lib/http.js';
import { randomToken } from '../lib/ids.js';
import { render, buildCtx } from '../lib/macros.js';
import { logger } from '../lib/logger.js';
import { pageNewestFirst } from './clicks.js';
import { REJECTED_STATUSES, BRANDCLICK_STATUS } from './conversions.js';

const col = () => getDb().collection('exports');
const logs = () => getDb().collection('export_logs');
const DAY_MS = 86400000;

export const PLATFORMS = {
  google_ads: { label: 'Google Ads', adClickTypes: ['gclid'], idHeader: 'Google Click ID', orderId: true },
  microsoft_ads: { label: 'Microsoft Advertising (Bing)', adClickTypes: ['msclkid'], idHeader: 'Microsoft Click ID', orderId: false },
  legacy_pcup: {
    label: 'Legacy /pc/up (db.bestoffers.biz format, Google header)',
    adClickTypes: ['gclid', 'msclkid'],
    idHeader: 'Google Click ID',
    legacy: true,
  },
  custom: { label: 'Custom CSV', adClickTypes: [] },
};
export const WINDOW_TYPES = [
  ['rolling', 'Rolling window (last N days)'],
  ['monthly', 'Calendar month'],
];
export const MONTHS = [
  ['previous', 'Previous month'],
  ['current', 'Current month to date'],
];
const OFFSET_RE = /^[+-](0\d|1[0-4])[0-5]\d$/;
const DEFAULT_CUSTOM = 'Click ID={clickid}\nAd click id={ad_click_id}\nConversion Time={conversion_time}\nPayout={payout}\nStatus={status}\nBrand={brand}\nDomain={domain}';

function list(v) {
  return [].concat(v || []).flatMap((s) => String(s).split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
}

export function fromBody(body, existing = {}) {
  const platform = PLATFORMS[body.platform] ? body.platform : 'google_ads';
  return {
    name: String(body.name || '').trim().slice(0, 80),
    platform,
    enabled: !!body.enabled,
    conversionName: String(body.conversionName || '').trim().slice(0, 100),
    includePayout: !!body.includePayout,
    currency: String(body.currency || 'USD').trim().toUpperCase().slice(0, 3),
    utcOffset: OFFSET_RE.test(String(body.utcOffset || '').trim()) ? String(body.utcOffset).trim() : '+0000',
    windowType: body.windowType === 'monthly' ? 'monthly' : 'rolling',
    windowDays: Math.min(90, Math.max(1, Math.round(Number(body.windowDays) || 2))),
    month: body.month === 'current' ? 'current' : 'previous',
    sourceIds: list(body.sourceIds),
    siteIds: list(body.siteIds).map((s) => s.toLowerCase()),
    statuses: list(body.statuses).map((s) => s.toLowerCase()),
    customColumns: String(body.customColumns || '').slice(0, 4000) || (platform === 'custom' ? DEFAULT_CUSTOM : ''),
    // /pc/up/?code=<legacyCode> serves this export (db.bestoffers.biz-compatible URL)
    legacyCode: String(body.legacyCode || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
    // "Hone=offline_leads" lines: conversion name per brand
    brandNames: String(body.brandNames || '').slice(0, 2000),
    authUser: String(body.authUser || '').trim().slice(0, 64),
    // Blank password field on edit keeps the current one.
    authPassword: body.authPassword ? String(body.authPassword).slice(0, 128) : existing.authPassword || '',
  };
}

async function validate(d, id = null) {
  if (!d.name) throw new HttpError(400, 'Name is required');
  if (d.legacyCode) {
    if (d.legacyCode.length < 6) throw new HttpError(400, 'Legacy code must be at least 6 characters');
    const clash = (await listExports()).find((e) => e.legacyCode === d.legacyCode && e.id !== id);
    if (clash) throw new HttpError(400, `Legacy code already used by export "${clash.name}"`);
  }
  // The legacy format falls back to per-row event_name / brand names, like the PHP tracker
  if (d.platform !== 'custom' && d.platform !== 'legacy_pcup' && !d.conversionName) throw new HttpError(400, 'Conversion name is required (must match the conversion action in the ad platform)');
  if (d.platform === 'custom' && parseColumns(d.customColumns).length === 0) throw new HttpError(400, 'Custom export needs at least one "Header={macro}" line');
  if (d.authUser && !d.authPassword) throw new HttpError(400, 'Set a password for the basic-auth user');
}

export async function listExports() {
  return toList(await col().get()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getById(id) {
  return toObj(await col().doc(id).get());
}

export async function create(body) {
  const d = fromBody(body);
  await validate(d);
  const now = Date.now();
  const ref = await col().add({ ...d, token: randomToken(20), createdAt: now, updatedAt: now });
  return getById(ref.id);
}

export async function update(id, body) {
  const existing = await getById(id);
  if (!existing) throw new HttpError(404, 'Export not found');
  const d = fromBody(body, existing);
  await validate(d, id);
  await col().doc(id).update({ ...d, updatedAt: Date.now() });
  return getById(id);
}

export async function rotateToken(id) {
  await col().doc(id).update({ token: randomToken(20), updatedAt: Date.now() });
}

export async function remove(id) {
  await col().doc(id).delete();
}

// ---- Window + formatting ----

function offsetMs(utcOffset) {
  const sign = utcOffset[0] === '-' ? -1 : 1;
  return sign * (Number(utcOffset.slice(1, 3)) * 60 + Number(utcOffset.slice(3, 5))) * 60000;
}

/** [from, to) in epoch ms. Calendar months follow the export's UTC offset. */
export function windowRange(exp, now = Date.now()) {
  if (exp.windowType !== 'monthly') return { from: now - exp.windowDays * DAY_MS, to: now + 1 };
  const off = offsetMs(exp.utcOffset || '+0000');
  const local = new Date(now + off);
  let y = local.getUTCFullYear();
  let m = local.getUTCMonth();
  if (exp.month === 'previous') {
    const from = Date.UTC(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, 1) - off;
    return { from, to: Date.UTC(y, m, 1) - off };
  }
  return { from: Date.UTC(y, m, 1) - off, to: now + 1 };
}

/** "yyyy-MM-dd HH:mm:ss" in the given offset — accepted by Google Ads and Microsoft Advertising. */
export function fmtTime(ms, utcOffset = '+0000') {
  return new Date(ms + offsetMs(utcOffset)).toISOString().replace('T', ' ').slice(0, 19);
}

/** guard: prefix cells that a spreadsheet would run as formulas (custom exports only — never touch click ids sent to ad platforms). */
export function csvCell(v, guard = false) {
  let s = v === undefined || v === null ? '' : String(v);
  if (guard && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseColumns(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('=');
      return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1)] : null;
    })
    .filter(Boolean);
}

function matches(exp, conv) {
  // Default: every sale-type status. Brand clicks only when listed (e.g. a separate "Brand click" conversion action).
  const allowed = exp.statuses && exp.statuses.length ? exp.statuses.includes(conv.status) : !REJECTED_STATUSES.has(conv.status) && conv.status !== BRANDCLICK_STATUS;
  if (!allowed) return false;
  if (exp.sourceIds && exp.sourceIds.length && !exp.sourceIds.includes(conv.sourceId)) return false;
  if (exp.siteIds && exp.siteIds.length && !exp.siteIds.includes(conv.siteId)) return false;
  const types = PLATFORMS[exp.platform].adClickTypes;
  if (types.length && !(conv.adClickId && types.includes(conv.adClickType))) return false;
  return true;
}

/** "Hone=offline_leads" lines -> Map(lowercased brand -> conversion name). */
function brandNameMap(exp) {
  const m = new Map();
  for (const line of String(exp.brandNames || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) m.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return m;
}

/** Conversion name: the postback's event_name, else a per-brand name, else the export's name (as the PHP /pc/up did). */
export function conversionNameFor(exp, conv) {
  return conv.eventName || brandNameMap(exp).get(String(conv.brand || '').toLowerCase()) || exp.conversionName || '';
}

function ctxFor(exp, conv) {
  const click = { ...conv, id: conv.clickId, createdAt: conv.clickCreatedAt };
  const ctx = buildCtx({ click, conversion: conv });
  ctx.conversion_time = fmtTime(conv.createdAt, exp.utcOffset);
  ctx.click_time = conv.clickCreatedAt ? fmtTime(conv.clickCreatedAt, exp.utcOffset) : '';
  ctx.conversion_name = conversionNameFor(exp, conv);
  ctx.currency = exp.currency || '';
  if (!exp.includePayout) ctx.payout = '';
  return ctx;
}

function header(exp) {
  if (exp.platform === 'custom') return [parseColumns(exp.customColumns).map(([h]) => h)];
  const p = PLATFORMS[exp.platform];
  // db.bestoffers.biz /pc/up: no Parameters row; the offset is written into each time instead
  if (p.legacy) return [[p.idHeader, 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Currency Code']];
  const cols = [p.idHeader, 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency'];
  if (p.orderId) cols.push('Order ID');
  return [[`Parameters:TimeZone=${exp.utcOffset}`], cols];
}

function row(exp, conv) {
  const ctx = ctxFor(exp, conv);
  if (exp.platform === 'custom') return parseColumns(exp.customColumns).map(([, tpl]) => render(tpl, ctx, 'none'));
  if (PLATFORMS[exp.platform].legacy) {
    return [conv.adClickId, ctx.conversion_name, ctx.conversion_time + exp.utcOffset, ctx.payout, exp.currency || 'USD'];
  }
  const cells = [conv.adClickId, ctx.conversion_name, ctx.conversion_time, ctx.payout, exp.includePayout ? exp.currency : ''];
  if (PLATFORMS[exp.platform].orderId) cells.push(conv.id);
  return cells;
}

/**
 * Stream CSV lines for the export's window, oldest first within each page.
 * write(line) is called per line; returns the number of data rows.
 */
export async function generate(exp, write, { now = Date.now(), limit = Infinity } = {}) {
  const { from, to } = windowRange(exp, now);
  const guard = exp.platform === 'custom';
  const line = (cells) => cells.map((c) => csvCell(c, guard)).join(',') + '\r\n';
  for (const cells of header(exp)) write(line(cells));
  let rows = 0;
  let after;
  do {
    const page = await pageNewestFirst('conversions', { from, to, after, limit: 500 });
    for (const conv of page.rows) {
      if (!matches(exp, conv)) continue;
      write(line(row(exp, conv)));
      if (++rows >= limit) return rows;
    }
    after = page.nextAfter;
  } while (after);
  return rows;
}

export async function toCsv(exp, opts) {
  let out = '';
  const rows = await generate(exp, (l) => (out += l), opts);
  return { csv: out, rows };
}

function fileName(exp) {
  return `${String(exp.name).replace(/[^A-Za-z0-9_-]+/g, '_') || 'export'}.csv`;
}

async function logFetch(exp, req, rows, via) {
  await logs().add({ exportId: exp.id, via, rows, ip: req.ip || '', ua: String(req.get('user-agent') || '').slice(0, 200), createdAt: Date.now() });
  await col().doc(exp.id).update({ lastFetchedAt: Date.now(), lastRows: rows });
}

export async function listLogs(exportId, limit = 20) {
  return (await pageNewestFirst('export_logs', { equals: { exportId }, limit })).rows;
}

/** Send the CSV as a response (logged-in download or public token URL). */
export async function sendCsv(exp, req, res, via) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `${via === 'download' ? 'attachment' : 'inline'}; filename="${fileName(exp)}"`);
  res.set('Cache-Control', 'no-store');
  const rows = await generate(exp, (l) => res.write(l));
  res.end();
  logFetch(exp, req, rows, via).catch((err) => logger.error({ msg: 'export log failed', err: String(err) }));
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** GET /x/:token.csv */
export async function serveExportByToken(req, res) {
  res.set('Cache-Control', 'no-store');
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{16,64}$/.test(token)) return res.status(404).type('text').send('Not found');
  const exp = toList(await col().where('token', '==', token).limit(1).get())[0];
  if (!exp || !exp.enabled) return res.status(404).type('text').send('Not found');
  if (exp.authUser) {
    const h = req.get('authorization') || '';
    const decoded = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString('utf8') : '';
    const i = decoded.indexOf(':');
    if (i < 0 || !safeEqual(decoded.slice(0, i), exp.authUser) || !safeEqual(decoded.slice(i + 1), exp.authPassword)) {
      res.set('WWW-Authenticate', 'Basic realm="adlex export", charset="UTF-8"');
      return res.status(401).type('text').send('Authentication required');
    }
  }
  await sendCsv(exp, req, res, 'url');
}
