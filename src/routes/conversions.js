import { Router } from 'express';
import * as conversions from '../services/conversions.js';
import * as campaigns from '../services/campaigns.js';
import * as offers from '../services/offers.js';
import { parseRange, PRESETS } from '../lib/time.js';

export const conversionsRouter = Router();

conversionsRouter.get('/', async (req, res) => {
  const range = parseRange({ ...req.query, preset: req.query.preset || (req.query.from || req.query.to ? '' : '30d') });
  const filter = { campaignId: req.query.campaignId || '', offerId: req.query.offerId || '' };
  const { rows, nextAfter } = await conversions.listConversions({ ...filter, from: range.from, to: range.to, after: req.query.after });
  res.render('conversions/index', {
    title: 'Conversions',
    rows,
    nextAfter,
    range,
    presets: PRESETS,
    filter,
    campaignMap: await campaigns.mapById(),
    offerMap: await offers.mapById(),
    campaignList: await campaigns.list(),
    offerList: await offers.list(),
    baseQuery: { ...filter, preset: range.preset === 'custom' ? '' : range.preset, from: range.preset === 'custom' ? range.fromDay : '', to: range.preset === 'custom' ? range.toDay : '', after: req.query.after || '' },
  });
});
