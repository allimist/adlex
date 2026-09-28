/**
 * db.bestoffers.biz-compatible read endpoints, so existing scheduled imports and reports only need
 * their domain changed:
 *   GET /pc/up/?code=…                          offline-conversion CSV (the export whose Legacy code matches)
 *   GET /se/export?code=…&date_from=&date_to=   sessions (clicks) as the old `se` table
 *   GET /pc/export?code=…&date_from=&date_to=   events (brand clicks + postbacks) as the old `pc` table
 * The dump code is LEGACY_REPORT_CODE; without it the dumps are disabled.
 */
import { config } from '../config.js';
import { pageNewestFirst } from './clicks.js';
import { listExports, sendCsv, csvCell, safeEqual } from './exports.js';
import { mapById as sourcesById } from './sources.js';
import { BRANDCLICK_STATUS } from './conversions.js';
import { tValue } from '../lib/tparams.js';

function str(v, max = 200) {
  if (Array.isArray(v)) v = v[0];
  return v === undefined || v === null ? '' : String(v).slice(0, max);
}

/** GET /pc/up/?code= */
export async function serveLegacyUpload(req, res) {
  res.set('Cache-Control', 'no-store');
  const code = str(req.query.code, 64);
  if (!code) return res.status(400).type('text').send('No code provided.');
  const exp = (await listExports()).find((e) => e.enabled && e.legacyCode && safeEqual(e.legacyCode, code));
  if (!exp) return res.status(403).type('text').send('Access denied.');
  await sendCsv(exp, req, res, 'legacy');
}

/** "2025-10-01" or "2025-10-01 12:00:00" (UTC) -> ms; a bare date as upper bound covers the whole day. */
export function parseBound(s, upper) {
  const v = str(s, 19).trim();
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(v);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2] || (upper ? '23:59:59' : '00:00:00')}Z`);
  if (Number.isNaN(t)) return null;
  return upper ? t + (m[2] && m[2].length === 5 ? 60000 : 1000) : t;
}

function fmt(ms) {
  return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '';
}

/** Value of a legacy column (campaignid, keyword, …) through the source's t1…t20 param names. */
function byParamName(doc, source, name) {
  const params = (source && source.params) || {};
  for (const [key, p] of Object.entries(params)) {
    if (/^t\d+$/.test(key) && p && String(p.name || '').toLowerCase() === name) return tValue(doc, key);
  }
  return '';
}

const SE_COLUMNS = ['id', 'date', 'gclid', 'campaignid', 'page_url', 'adgroupid', 'keyword', 'device', 'source'];
const PC_COLUMNS = ['id', 'created_at', 'record_source', 'event_type', 'event_name', 'event_id', 'date', 'brand', 'revenue', 'gclid', 'campaignid', 'page_url', 'adgroupid', 'keyword', 'source', 'device'];

function seRow(c, src) {
  return [
    c.id,
    fmt(c.createdAt),
    c.adClickId || '',
    byParamName(c, src, 'campaignid'),
    c.pageUrl || '',
    byParamName(c, src, 'adgroupid'),
    byParamName(c, src, 'keyword'),
    byParamName(c, src, 'device'),
    byParamName(c, src, 'source') || c.adClickType || '',
  ];
}

function pcRow(v, src) {
  const brandClick = v.status === BRANDCLICK_STATUS;
  return [
    v.id,
    fmt(v.createdAt),
    brandClick ? 'site' : 'postback',
    brandClick ? 'brandclick' : v.status || '',
    v.eventName || '',
    v.clickId || '',
    fmt(v.createdAt),
    v.brand || '',
    brandClick ? '' : v.payout,
    v.adClickId || '',
    byParamName(v, src, 'campaignid'),
    v.pageUrl || '',
    byParamName(v, src, 'adgroupid'),
    byParamName(v, src, 'keyword'),
    v.adClickType || '',
    byParamName(v, src, 'device'),
  ];
}

/** GET /se/export and /pc/export: newest first, like the PHP `ORDER BY date DESC`. */
export function serveLegacyDump(kind) {
  const collection = kind === 'se' ? 'clicks' : 'conversions';
  const columns = kind === 'se' ? SE_COLUMNS : PC_COLUMNS;
  const toRow = kind === 'se' ? seRow : pcRow;
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!config.legacyReportCode) return res.status(404).type('text').send('Not found');
    const code = str(req.query.code, 64);
    if (!code) return res.status(400).type('text').send('No code provided.');
    if (!safeEqual(code, config.legacyReportCode)) return res.status(403).type('text').send('Access denied.');
    const from = parseBound(req.query.date_from, false) ?? 0;
    const to = parseBound(req.query.date_to, true) ?? Date.now() + 86400000;
    const sources = await sourcesById();

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${kind}_export.csv"`);
    const line = (cells) => cells.map((c) => csvCell(c)).join(',') + '\n';
    res.write(line(columns));
    let after;
    do {
      const page = await pageNewestFirst(collection, { from, to, after, limit: 500 });
      for (const doc of page.rows) res.write(line(toRow(doc, sources.get(doc.sourceId))));
      after = page.nextAfter;
    } while (after);
    res.end();
  };
}
