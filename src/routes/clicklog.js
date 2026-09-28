import { Router } from 'express';
import * as clicks from '../services/clicks.js';
import * as campaigns from '../services/campaigns.js';
import * as offers from '../services/offers.js';
import { parseRange, PRESETS } from '../lib/time.js';
import { T_KEYS, T_BASE_KEYS, tValue } from '../lib/tparams.js';

export const clicklogRouter = Router();

/** Optional website columns, toggled in the same picker as t1…t20. */
export const EXTRA_COLS = [
  ['domain', 'Site'],
  ['adClickId', 'Ad click id'],
  ['lastBrand', 'Brand'],
  ['outclicks', 'Outclicks'],
  ['ua', 'User agent'],
];
const PICKABLE = [...EXTRA_COLS.map(([k]) => k), ...T_KEYS];

/** Which columns to show is remembered per login session; default: website columns + t1–t5. */
function visibleCols(req) {
  const saved = req.session && req.session.clicklogTCols;
  return Array.isArray(saved) ? PICKABLE.filter((k) => saved.includes(k)) : [...EXTRA_COLS.map(([k]) => k), ...T_BASE_KEYS];
}

clicklogRouter.get('/', async (req, res) => {
  if (req.query.tcols_set) {
    const picked = [].concat(req.query.tcols || []).map(String);
    req.session.clicklogTCols = PICKABLE.filter((k) => picked.includes(k));
    const rest = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) if (k !== 'tcols' && k !== 'tcols_set') [].concat(v).forEach((x) => rest.append(k, x));
    const qs = rest.toString();
    return res.redirect(`/clicklog${qs ? `?${qs}` : ''}`);
  }
  const range = parseRange({ ...req.query, preset: req.query.preset || (req.query.from || req.query.to ? '' : 'today') });
  const filter = { campaignId: req.query.campaignId || '', siteId: req.query.siteId || '', converted: req.query.converted || '' };
  const { rows, nextAfter } = await clicks.listClicks({ ...filter, from: range.from, to: range.to, after: req.query.after });
  res.render('clicklog/index', {
    title: 'Clicklog',
    rows,
    nextAfter,
    range,
    presets: PRESETS,
    filter,
    campaignMap: await campaigns.mapById(),
    offerMap: await offers.mapById(),
    campaignList: await campaigns.list(),
    tKeys: T_KEYS,
    extraCols: EXTRA_COLS,
    cols: visibleCols(req),
    tValue,
    baseQuery: { ...filter, preset: range.preset === 'custom' ? '' : range.preset, from: range.preset === 'custom' ? range.fromDay : '', to: range.preset === 'custom' ? range.toDay : '', after: req.query.after || '' },
  });
});
