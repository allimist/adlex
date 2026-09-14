import { Router } from 'express';
import * as campaigns from '../services/campaigns.js';
import * as sources from '../services/sources.js';
import * as offers from '../services/offers.js';
import * as postbacks from '../services/postbacks.js';
import * as reports from '../services/reports.js';
import { parseRange } from '../lib/time.js';
import { flash, HttpError } from '../lib/http.js';
import { MACRO_LIST } from '../lib/macros.js';

export const campaignsRouter = Router();

async function formData(item, extra = {}) {
  return {
    item,
    sourceList: await sources.list({ includeArchived: false }),
    offerList: await offers.list({ includeArchived: false }),
    statuses: campaigns.STATUSES,
    macroList: MACRO_LIST,
    ...extra,
  };
}

campaignsRouter.get('/', async (req, res) => {
  const rows = await campaigns.list();
  const sourceMap = await sources.mapById();
  const today = parseRange({ preset: 'today' });
  const { rows: statRows } = await reports.aggregate({ from: today.from, to: today.to, groupBy: 'campaignId' });
  const stats = new Map(statRows.map((r) => [r.key, r]));
  res.render('campaigns/index', { title: 'Campaigns', rows, sourceMap, stats });
});

campaignsRouter.get('/new', async (req, res) => {
  const item = { name: '', sourceId: req.query.sourceId || '', offers: [{ offerId: '', weight: 100 }], costPerClick: 0, fallbackUrl: '', status: 'active', postbackToken: '' };
  res.render('campaigns/form', { title: 'New campaign', isNew: true, ...(await formData(item)) });
});

campaignsRouter.post('/', async (req, res) => {
  try {
    const c = await campaigns.create(req.body);
    flash(req, 'success', 'Campaign created');
    res.redirect(`/campaigns/${c.id}`);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const item = { ...req.body, offers: campaigns.offersFromBody(req.body), postbackToken: req.body.requireToken ? 'x' : '' };
    res.status(err.status).render('campaigns/form', { title: 'New campaign', isNew: true, error: err.message, ...(await formData(item)) });
  }
});

campaignsRouter.get('/:id', async (req, res) => {
  const item = await campaigns.getById(req.params.id);
  if (!item) throw new HttpError(404, 'Campaign not found');
  const source = await sources.getById(item.sourceId);
  const offerMap = await offers.mapById(item.offers.map((o) => o.offerId));
  const range = parseRange({ preset: '7d' });
  const { total } = await reports.aggregate({ from: range.from, to: range.to, groupBy: 'campaignId', filter: { campaignId: item.id } });
  const byOffer = await reports.aggregate({ from: range.from, to: range.to, groupBy: 'offerId', filter: { campaignId: item.id } });
  res.render('campaigns/show', {
    title: item.name,
    item,
    source,
    offerMap,
    clickUrl: campaigns.buildClickUrl(item, source),
    postbackUrl: campaigns.postbackUrl(item),
    triggers: await postbacks.effectiveForCampaign(item),
    stats: total,
    offerStats: new Map(byOffer.rows.map((r) => [r.key, r])),
    range,
  });
});

campaignsRouter.get('/:id/edit', async (req, res) => {
  const item = await campaigns.getById(req.params.id);
  if (!item) throw new HttpError(404, 'Campaign not found');
  res.render('campaigns/form', { title: 'Edit campaign', isNew: false, ...(await formData(item)) });
});

campaignsRouter.post('/:id', async (req, res) => {
  try {
    await campaigns.update(req.params.id, req.body);
    flash(req, 'success', 'Campaign updated');
    res.redirect(`/campaigns/${req.params.id}`);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const existing = await campaigns.getById(req.params.id);
    const item = { ...existing, ...req.body, offers: campaigns.offersFromBody(req.body), postbackToken: req.body.requireToken ? existing.postbackToken || 'x' : '' };
    res.status(err.status).render('campaigns/form', { title: 'Edit campaign', isNew: false, error: err.message, ...(await formData(item)) });
  }
});

campaignsRouter.post('/:id/delete', async (req, res) => {
  await campaigns.remove(req.params.id);
  flash(req, 'success', 'Campaign deleted');
  res.redirect('/campaigns');
});

campaignsRouter.post('/:id/regenerate-token', async (req, res) => {
  await campaigns.regenerateToken(req.params.id);
  flash(req, 'success', 'Postback token regenerated');
  res.redirect(`/campaigns/${req.params.id}`);
});
