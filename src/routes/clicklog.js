import { Router } from 'express';
import * as clicks from '../services/clicks.js';
import * as campaigns from '../services/campaigns.js';
import * as offers from '../services/offers.js';
import { parseRange, PRESETS } from '../lib/time.js';

export const clicklogRouter = Router();

clicklogRouter.get('/', async (req, res) => {
  const range = parseRange({ ...req.query, preset: req.query.preset || (req.query.from || req.query.to ? '' : 'today') });
  const filter = { campaignId: req.query.campaignId || '', converted: req.query.converted || '' };
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
    baseQuery: { ...filter, preset: range.preset === 'custom' ? '' : range.preset, from: range.preset === 'custom' ? range.fromDay : '', to: range.preset === 'custom' ? range.toDay : '', after: req.query.after || '' },
  });
});
