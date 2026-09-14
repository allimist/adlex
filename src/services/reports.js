import { getDb } from '../db/index.js';
import { toList } from '../db/adapter.js';
import { REJECTED_STATUSES } from './conversions.js';

export const GROUPS = [
  ['campaigns', 'Campaigns', 'campaignId'],
  ['offers', 'Offers', 'offerId'],
  ['sources', 'Traffic sources', 'sourceId'],
];

function emptyRow(key) {
  return { key, clicks: 0, uniques: 0, conversions: 0, revenue: 0, cost: 0, _ips: new Set() };
}

function finish(r) {
  r.uniques = r._ips.size;
  delete r._ips;
  r.profit = r.revenue - r.cost;
  r.cr = r.clicks ? r.conversions / r.clicks : NaN;
  r.roi = r.cost ? r.profit / r.cost : NaN;
  r.epc = r.clicks ? r.revenue / r.clicks : 0;
  r.cpc = r.clicks ? r.cost / r.clicks : 0;
  return r;
}

/**
 * Aggregate clicks (by click time) and conversions (attributed to click time) in [from, to).
 * Scans documents in memory; see firestoreStore.js for the stats_daily plan at scale.
 */
export async function aggregate({ from, to, groupBy = 'campaignId', filter = {} }) {
  const db = getDb();
  let cq = db.collection('clicks').where('createdAt', '>=', from).where('createdAt', '<', to);
  let vq = db.collection('conversions').where('clickCreatedAt', '>=', from).where('clickCreatedAt', '<', to);
  for (const [k, v] of Object.entries(filter)) {
    if (v) {
      cq = cq.where(k, '==', v);
      vq = vq.where(k, '==', v);
    }
  }
  const clicks = toList(await cq.get());
  const conversions = toList(await vq.get());

  const rows = new Map();
  const total = emptyRow('__total');
  const row = (key) => {
    if (!rows.has(key)) rows.set(key, emptyRow(key));
    return rows.get(key);
  };
  for (const c of clicks) {
    const r = row(c[groupBy] || '');
    r.clicks++;
    total.clicks++;
    r.cost += Number(c.cost) || 0;
    total.cost += Number(c.cost) || 0;
    if (c.ip) {
      r._ips.add(c.ip);
      total._ips.add(c.ip);
    }
  }
  for (const v of conversions) {
    if (REJECTED_STATUSES.has(v.status)) continue;
    const r = row(v[groupBy] || '');
    r.conversions++;
    total.conversions++;
    r.revenue += Number(v.payout) || 0;
    total.revenue += Number(v.payout) || 0;
  }
  const list = [...rows.values()].map(finish).sort((a, b) => b.clicks - a.clicks);
  return { rows: list, total: finish(total) };
}
