import { getDb } from '../db/index.js';
import { toList, toObj } from '../db/adapter.js';
import { HttpError } from '../lib/http.js';
import { invalidateBundles } from './campaigns.js';
import { T_KEYS, T_BASE_KEYS, normalizeSourceParams, activeTKeys } from '../lib/tparams.js';

const col = () => getDb().collection('sources');

export const FIXED_KEYS = ['clickid', 'cost'];
export const PARAM_KEYS = [...FIXED_KEYS, ...T_KEYS];
export const COST_MODELS = [
  ['cpc', 'Fixed cost per click (campaign setting)'],
  ['param', 'Read cost from the mapped "cost" query param'],
  ['none', 'No cost tracking'],
];
export const STATUSES = ['active', 'archived'];

function emptyParams() {
  const p = {};
  for (const k of [...FIXED_KEYS, ...T_BASE_KEYS]) p[k] = { name: k, token: '' };
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
      t1: { name: 't1', token: '${ZONEID}' },
      t2: { name: 't2', token: '${CAMPAIGNID}' },
      t3: { name: 't3', token: '${BANNERID}' },
      t4: { name: 't4', token: '${OS}' },
      t5: { name: 't5', token: '${BROWSER}' },
    },
  },
  bing: {
    label: 'Microsoft Ads (Bing)',
    costModel: 'none',
    params: {
      clickid: { name: 'msclkid', token: '{msclkid}', hideInUrl: true }, // Bing appends msclkid itself
      cost: { name: 'cost', token: '' },
      t1: { name: 'CampaignId', token: '{CampaignId}' },
      t2: { name: 'AdGroupId', token: '{AdGroupId}' },
      t3: { name: 'keyword', token: '{keyword:}' },
      t4: { name: 'MatchType', token: '{MatchType}' },
      t5: { name: 'Device', token: '{Device}' },
    },
  },
  website: {
    label: 'Website (Google / Bing ads)',
    costModel: 'none',
    params: {
      clickid: { name: 'clickid', token: '' },
      cost: { name: 'cost', token: '' },
      t1: { name: 'campaignid', token: '{campaignid}' },
      t2: { name: 'adgroupid', token: '{adgroupid}' },
      t3: { name: 'keyword', token: '{keyword}' },
      t4: { name: 'device', token: '{device}' },
      t5: { name: 'utm_source', token: '' },
    },
  },
  facebook: {
    label: 'Facebook Ads',
    costModel: 'cpc',
    params: {
      clickid: { name: 'clickid', token: '{{ad.id}}_{{placement}}' },
      cost: { name: 'cost', token: '' },
      t1: { name: 't1', token: '{{campaign.id}}' },
      t2: { name: 't2', token: '{{adset.id}}' },
      t3: { name: 't3', token: '{{ad.id}}' },
      t4: { name: 't4', token: '{{placement}}' },
      t5: { name: 't5', token: '{{site_source_name}}' },
    },
  },
};

function normalize(row) {
  if (row) row.params = normalizeSourceParams(row.params);
  return row;
}

export async function list({ includeArchived = true } = {}) {
  let rows = toList(await col().get()).map(normalize);
  if (!includeArchived) rows = rows.filter((r) => r.status !== 'archived');
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getById(id) {
  return normalize(toObj(await col().doc(id).get()));
}

export async function mapById(ids) {
  const out = new Map();
  const rows = ids ? await Promise.all([...new Set(ids)].map((id) => getById(id))) : await list();
  for (const r of rows) if (r) out.set(r.id, r);
  return out;
}

/**
 * Parse flat form fields param_name_<key> / param_token_<key>.
 * clickid, cost and t1–t5 are always kept; t6–t20 only when filled in (a token without a name reads ?tN=).
 */
export function paramsFromBody(body) {
  const params = {};
  for (const k of PARAM_KEYS) {
    let name = String(body[`param_name_${k}`] || '').trim().replace(/[^A-Za-z0-9_\-.]/g, '').slice(0, 64);
    const token = String(body[`param_token_${k}`] || '').trim().slice(0, 255);
    const optional = !FIXED_KEYS.includes(k) && !T_BASE_KEYS.includes(k);
    if (optional && !name && !token) continue;
    if (optional && !name) name = k;
    params[k] = { name, token, hideInUrl: !!body[`param_hide_${k}`] };
  }
  return params;
}

export { activeTKeys };

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
    postbackToken: String(body.postbackToken || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
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
