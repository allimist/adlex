import { getDb } from '../db/index.js';
import { toList, toObj } from '../db/adapter.js';
import { HttpError } from '../lib/http.js';
import { invalidateBundles } from './campaigns.js';

const col = () => getDb().collection('offers');
export const STATUSES = ['active', 'paused', 'archived'];

export async function list({ includeArchived = true } = {}) {
  let rows = toList(await col().get());
  if (!includeArchived) rows = rows.filter((r) => r.status !== 'archived');
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getById(id) {
  return toObj(await col().doc(id).get());
}

export async function mapById(ids) {
  const out = new Map();
  const rows = ids ? await Promise.all([...new Set(ids)].map((id) => getById(id))) : await list();
  for (const r of rows) if (r) out.set(r.id, r);
  return out;
}

function fromBody(body) {
  return {
    name: String(body.name || '').trim(),
    network: String(body.network || '').trim().slice(0, 80),
    url: String(body.url || '').trim(),
    payout: Number(body.payout) || 0,
    currency: String(body.currency || 'USD').trim().toUpperCase().slice(0, 3) || 'USD',
    status: body.status || 'active',
    appendTracking: !!body.appendTracking,
    trackingParam: String(body.trackingParam || 'se').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'se',
  };
}

function validate(data) {
  if (!data.name || data.name.length > 80) throw new HttpError(400, 'Name is required (max 80 chars)');
  if (!/^https?:\/\/.+/i.test(data.url)) throw new HttpError(400, 'URL must start with http:// or https://');
  if (data.payout < 0) throw new HttpError(400, 'Payout cannot be negative');
  if (!STATUSES.includes(data.status)) throw new HttpError(400, 'Invalid status');
}

export async function create(body) {
  const data = fromBody(body);
  validate(data);
  const now = Date.now();
  const ref = await col().add({ ...data, createdAt: now, updatedAt: now });
  return getById(ref.id);
}

export async function update(id, body) {
  if (!(await getById(id))) throw new HttpError(404, 'Offer not found');
  const data = fromBody(body);
  validate(data);
  await col().doc(id).update({ ...data, updatedAt: Date.now() });
  invalidateBundles();
  return getById(id);
}

export async function remove(id) {
  const campaigns = toList(await getDb().collection('campaigns').get());
  if (campaigns.some((c) => (c.offers || []).some((o) => o.offerId === id))) {
    throw new HttpError(400, 'Cannot delete: a campaign uses this offer');
  }
  await col().doc(id).delete();
  invalidateBundles();
}
