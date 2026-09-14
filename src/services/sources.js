import { getDb } from '../db/index.js';
import { toList, toObj } from '../db/adapter.js';
import { HttpError } from '../lib/http.js';
import { invalidateBundles } from './campaigns.js';

const col = () => getDb().collection('sources');

export const PARAM_KEYS = ['clickid', 'cost', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5'];
export const COST_MODELS = [
  ['cpc', 'Fixed cost per click (campaign setting)'],
  ['param', 'Read cost from the mapped "cost" query param'],
  ['none', 'No cost tracking'],
];
export const STATUSES = ['active', 'archived'];

function emptyParams() {
  const p = {};
  for (const k of PARAM_KEYS) p[k] = { name: k, token: '' };
  return p;
}

export const PRESETS = {
  generic: { label: 'Generic', costModel: 'cpc', params: emptyParams() },
  propellerads: {
    label: 'PropellerAds',
    costModel: 'param',
    params: {
      clickid: { name: 'clickid', token: '${SUBID}' },
      cost: { name: 'cost', token: '${COST}' },
      sub1: { name: 'sub1', token: '${ZONEID}' },
      sub2: { name: 'sub2', token: '${CAMPAIGNID}' },
      sub3: { name: 'sub3', token: '${BANNERID}' },
      sub4: { name: 'sub4', token: '${OS}' },
      sub5: { name: 'sub5', token: '${BROWSER}' },
    },
  },
  facebook: {
    label: 'Facebook Ads',
    costModel: 'cpc',
    params: {
      clickid: { name: 'clickid', token: '{{ad.id}}_{{placement}}' },
      cost: { name: 'cost', token: '' },
      sub1: { name: 'sub1', token: '{{campaign.id}}' },
      sub2: { name: 'sub2', token: '{{adset.id}}' },
      sub3: { name: 'sub3', token: '{{ad.id}}' },
      sub4: { name: 'sub4', token: '{{placement}}' },
      sub5: { name: 'sub5', token: '{{site_source_name}}' },
    },
  },
};

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

/** Parse flat form fields param_name_<key> / param_token_<key>. */
export function paramsFromBody(body) {
  const params = {};
  for (const k of PARAM_KEYS) {
    const name = String(body[`param_name_${k}`] || '').trim().replace(/[^A-Za-z0-9_\-.]/g, '');
    const token = String(body[`param_token_${k}`] || '').trim();
    params[k] = { name, token };
  }
  return params;
}

function validate(data) {
  if (!data.name || data.name.length > 80) throw new HttpError(400, 'Name is required (max 80 chars)');
  if (!COST_MODELS.some(([k]) => k === data.costModel)) throw new HttpError(400, 'Invalid cost model');
  if (!STATUSES.includes(data.status)) throw new HttpError(400, 'Invalid status');
}

function fromBody(body) {
  return {
    name: String(body.name || '').trim(),
    costModel: body.costModel || 'cpc',
    params: paramsFromBody(body),
    notes: String(body.notes || '').slice(0, 2000),
    status: body.status || 'active',
  };
}

export async function create(body) {
  const data = fromBody(body);
  validate(data);
  const now = Date.now();
  const ref = await col().add({ ...data, createdAt: now, updatedAt: now });
  return getById(ref.id);
}

export async function update(id, body) {
  const existing = await getById(id);
  if (!existing) throw new HttpError(404, 'Traffic source not found');
  const data = fromBody(body);
  validate(data);
  await col().doc(id).update({ ...data, updatedAt: Date.now() });
  invalidateBundles();
  return getById(id);
}

export async function remove(id) {
  const db = getDb();
  const used = await db.collection('campaigns').where('sourceId', '==', id).limit(1).get();
  if (!used.empty) throw new HttpError(400, 'Cannot delete: a campaign uses this traffic source');
  const trig = await db.collection('triggers').where('sourceId', '==', id).limit(1).get();
  if (!trig.empty) throw new HttpError(400, 'Cannot delete: a trigger uses this traffic source');
  await col().doc(id).delete();
  invalidateBundles();
}
