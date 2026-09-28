/** Websites that may send tracking events to /se/ and /pc/. The document id is the normalized domain. */
import { getDb } from '../db/index.js';
import { toList, toObj } from '../db/adapter.js';
import { HttpError } from '../lib/http.js';
import { TtlCache } from '../lib/cache.js';

const col = () => getDb().collection('sites');
export const STATUSES = ['active', 'archived'];
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const lookups = new TtlCache(30000);

/** "https://www.Example.com:443/path" -> "example.com"; returns '' when it is not a hostname. */
export function normalizeDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  s = s.replace(/^www\./, '');
  return DOMAIN_RE.test(s) ? s : '';
}

export async function list({ includeArchived = true } = {}) {
  let rows = toList(await col().get());
  if (!includeArchived) rows = rows.filter((r) => r.status !== 'archived');
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getById(id) {
  return toObj(await col().doc(id).get());
}

export async function mapById() {
  return new Map((await list()).map((s) => [s.id, s]));
}

async function assertSource(sourceId) {
  if (!sourceId || !(await getDb().collection('sources').doc(sourceId).get()).exists) {
    throw new HttpError(400, 'Traffic source is required');
  }
}

/**
 * Add many domains at once (one per line, commas and spaces also split).
 * Existing domains are left untouched. Returns { added: [...], skipped: [...], invalid: [...] }.
 */
export async function addMany({ domains, sourceId, notes = '' }) {
  await assertSource(sourceId);
  const raw = String(domains || '').split(/[\s,;]+/).filter(Boolean);
  if (raw.length === 0) throw new HttpError(400, 'Enter at least one domain');
  if (raw.length > 5000) throw new HttpError(400, 'At most 5000 domains per request');
  const invalid = [];
  const wanted = new Set();
  for (const r of raw) {
    const d = normalizeDomain(r);
    if (d) wanted.add(d);
    else invalid.push(r);
  }
  const added = [];
  const skipped = [];
  const now = Date.now();
  const ids = [...wanted];
  const snaps = await Promise.all(ids.map((d) => col().doc(d).get()));
  let batch = getDb().batch();
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    if (snaps[i].exists) {
      skipped.push(ids[i]);
      continue;
    }
    batch.set(col().doc(ids[i]), { sourceId, status: 'active', notes: String(notes).slice(0, 500), createdAt: now, updatedAt: now });
    added.push(ids[i]);
    if (++n % 400 === 0) {
      await batch.commit();
      batch = getDb().batch();
    }
  }
  await batch.commit();
  lookups.clear();
  return { added, skipped, invalid };
}

export async function update(id, body) {
  const existing = await getById(id);
  if (!existing) throw new HttpError(404, 'Site not found');
  const data = { sourceId: String(body.sourceId || ''), status: body.status || 'active', notes: String(body.notes || '').slice(0, 500) };
  await assertSource(data.sourceId);
  if (!STATUSES.includes(data.status)) throw new HttpError(400, 'Invalid status');
  await col().doc(id).update({ ...data, updatedAt: Date.now() });
  lookups.clear();
  return getById(id);
}

export async function remove(id) {
  await col().doc(id).delete();
  lookups.clear();
}

/**
 * Find the active site for a hostname: exact match first, then parent domains
 * (so lp.example.com is covered by example.com). Cached, including misses.
 */
export async function findByHost(host) {
  const domain = normalizeDomain(host);
  if (!domain) return null;
  const hit = lookups.get(domain);
  if (hit !== undefined) return hit;
  const labels = domain.split('.');
  let found = null;
  for (let i = 0; i < labels.length && !found; i++) {
    const candidate = labels.slice(i).join('.');
    if (i > 0 && !candidate.includes('.')) break; // never match a bare TLD
    const s = toObj(await col().doc(candidate).get());
    if (s && s.status === 'active') found = s;
  }
  return lookups.set(domain, found);
}

/** Host the browser request came from: Origin, else Referer. */
export function requestHost(req) {
  for (const h of [req.get('origin'), req.get('referer')]) {
    if (!h || h === 'null') continue;
    try {
      return new URL(h).hostname;
    } catch {
      // ignore malformed header
    }
  }
  return '';
}
