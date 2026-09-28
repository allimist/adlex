import { getDb } from '../db/index.js';
import { toList, toObj } from '../db/adapter.js';
import { HttpError } from '../lib/http.js';
import { TtlCache } from '../lib/cache.js';
import { shortKey, randomToken } from '../lib/ids.js';
import { config } from '../config.js';
import { normalizeSourceParams } from '../lib/tparams.js';

const col = () => getDb().collection('campaigns');
export const STATUSES = ['active', 'paused', 'archived'];

const bundles = new TtlCache(10000);
export function invalidateBundles() {
  bundles.clear();
}

export async function list() {
  const rows = toList(await col().get());
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getById(id) {
  return toObj(await col().doc(id).get());
}

export async function mapById() {
  const out = new Map();
  for (const r of await list()) out.set(r.id, r);
  return out;
}

export async function getByKey(key) {
  const qs = await col().where('key', '==', key).limit(1).get();
  return qs.empty ? null : toObj(qs.docs[0]);
}

/** Campaign + source + resolved offers, cached for the click hot path. */
export async function getBundleByKey(key) {
  const hit = bundles.get(key);
  if (hit !== undefined) return hit;
  const campaign = await getByKey(key);
  if (!campaign) return bundles.set(key, null);
  const db = getDb();
  const source = toObj(await db.collection('sources').doc(campaign.sourceId).get());
  if (source) source.params = normalizeSourceParams(source.params);
  const offers = [];
  for (const entry of campaign.offers || []) {
    const offer = toObj(await db.collection('offers').doc(entry.offerId).get());
    if (offer) offers.push({ ...offer, weight: Number(entry.weight) || 0 });
  }
  return bundles.set(key, { campaign, source, offers });
}

/** Parse repeated offerId/weight form fields into [{offerId, weight}]. */
export function offersFromBody(body) {
  const ids = [].concat(body.offerId || []);
  const weights = [].concat(body.weight || []);
  const out = [];
  const seen = new Set();
  ids.forEach((offerId, i) => {
    if (!offerId || seen.has(offerId)) return;
    seen.add(offerId);
    const w = Math.max(0, Math.min(1000, Math.round(Number(weights[i]) || 0)));
    out.push({ offerId, weight: w });
  });
  return out;
}

function fromBody(body) {
  return {
    name: String(body.name || '').trim(),
    sourceId: String(body.sourceId || ''),
    offers: offersFromBody(body),
    costPerClick: Math.max(0, Number(body.costPerClick) || 0),
    fallbackUrl: String(body.fallbackUrl || '').trim(),
    status: body.status || 'active',
    allowLp: !!body.allowLp,
  };
}

async function validate(data) {
  if (!data.name || data.name.length > 80) throw new HttpError(400, 'Name is required (max 80 chars)');
  if (!data.sourceId || !(await getDb().collection('sources').doc(data.sourceId).get()).exists) {
    throw new HttpError(400, 'Traffic source is required');
  }
  if (data.offers.length === 0) throw new HttpError(400, 'Add at least one offer');
  for (const o of data.offers) {
    if (!(await getDb().collection('offers').doc(o.offerId).get()).exists) throw new HttpError(400, 'Unknown offer selected');
  }
  if (data.fallbackUrl && !/^https?:\/\/.+/i.test(data.fallbackUrl)) throw new HttpError(400, 'Fallback URL must be http(s)');
  if (!STATUSES.includes(data.status)) throw new HttpError(400, 'Invalid status');
}

async function uniqueKey() {
  for (let i = 0; i < 10; i++) {
    const key = shortKey(8);
    if (!(await getByKey(key))) return key;
  }
  throw new Error('Could not generate a unique campaign key');
}

export async function create(body) {
  const data = fromBody(body);
  await validate(data);
  const now = Date.now();
  const ref = await col().add({
    ...data,
    key: await uniqueKey(),
    postbackToken: body.requireToken ? randomToken(12) : '',
    createdAt: now,
    updatedAt: now,
  });
  invalidateBundles();
  return getById(ref.id);
}

export async function update(id, body) {
  const existing = await getById(id);
  if (!existing) throw new HttpError(404, 'Campaign not found');
  const data = fromBody(body);
  await validate(data);
  const patch = { ...data, updatedAt: Date.now() };
  if (body.requireToken && !existing.postbackToken) patch.postbackToken = randomToken(12);
  if (!body.requireToken) patch.postbackToken = '';
  await col().doc(id).update(patch);
  invalidateBundles();
  return getById(id);
}

export async function regenerateToken(id) {
  if (!(await getById(id))) throw new HttpError(404, 'Campaign not found');
  await col().doc(id).update({ postbackToken: randomToken(12), updatedAt: Date.now() });
  invalidateBundles();
}

export async function remove(id) {
  await col().doc(id).delete();
  invalidateBundles();
}

/** Click URL with the source's own tokens, e.g. .../click/abc123?clickid=${SUBID}&cost=${COST} */
export function buildClickUrl(campaign, source) {
  const base = `${config.baseUrl}/click/${campaign.key}`;
  // {lpurl} is the final URL macro in Microsoft Ads and Google Ads tracking templates.
  const parts = campaign.allowLp ? ['lp={lpurl}'] : [];
  if (!source || !source.params) return parts.length ? `${base}?${parts.join('&')}` : base;
  for (const [key, p] of Object.entries(source.params)) {
    if (p && p.hideInUrl) continue; // added by the ad platform itself (e.g. msclkid); still read on /click
    if (p && p.name && p.token) parts.push(`${p.name}=${p.token}`);
    else if (p && p.name && key !== 'cost') parts.push(`${p.name}=`);
  }
  return parts.length ? `${base}?${parts.join('&')}` : base;
}

export function postbackUrl(campaign) {
  const token = campaign && campaign.postbackToken ? `&token=${campaign.postbackToken}` : '';
  return `${config.baseUrl}/postback?clickid={clickid}&payout={payout}&status={status}&txid={txid}${token}`;
}
