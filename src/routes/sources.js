import { Router } from 'express';
import * as sources from '../services/sources.js';
import * as postbacks from '../services/postbacks.js';
import * as reports from '../services/reports.js';
import { parseRange } from '../lib/time.js';
import { flash, HttpError } from '../lib/http.js';
import { T_MAX, T_BASE_KEYS } from '../lib/tparams.js';

export const sourcesRouter = Router();

function formLocals(extra) {
  return { costModels: sources.COST_MODELS, statuses: sources.STATUSES, paramKeys: sources.PARAM_KEYS, fixedKeys: sources.FIXED_KEYS, tBaseKeys: T_BASE_KEYS, tMax: T_MAX, activeTKeys: sources.activeTKeys, presets: sources.PRESETS, ...extra };
}

sourcesRouter.get('/', async (req, res) => {
  const rows = await sources.list();
  const today = parseRange({ preset: 'today' });
  const { rows: statRows } = await reports.aggregate({ from: today.from, to: today.to, groupBy: 'sourceId' });
  res.render('sources/index', { title: 'Traffic sources', rows, stats: new Map(statRows.map((r) => [r.key, r])) });
});

sourcesRouter.get('/new', (req, res) => {
  const preset = sources.PRESETS[req.query.preset] || sources.PRESETS.generic;
  const item = { name: preset === sources.PRESETS.generic ? '' : preset.label, costModel: preset.costModel, params: preset.params, notes: '', status: 'active' };
  res.render('sources/form', formLocals({ title: 'New traffic source', isNew: true, item, triggers: [] }));
});

sourcesRouter.post('/', async (req, res) => {
  try {
    const s = await sources.create(req.body);
    flash(req, 'success', 'Traffic source created');
    res.redirect(`/sources/${s.id}/edit`);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const item = { ...req.body, params: sources.paramsFromBody(req.body) };
    res.status(err.status).render('sources/form', formLocals({ title: 'New traffic source', isNew: true, item, triggers: [], error: err.message }));
  }
});

sourcesRouter.get('/:id', (req, res) => res.redirect(`/sources/${req.params.id}/edit`));

sourcesRouter.get('/:id/edit', async (req, res) => {
  const item = await sources.getById(req.params.id);
  if (!item) throw new HttpError(404, 'Traffic source not found');
  const triggers = await postbacks.list({ sourceId: item.id });
  res.render('sources/form', formLocals({ title: 'Edit traffic source', isNew: false, item, triggers }));
});

sourcesRouter.post('/:id', async (req, res) => {
  try {
    await sources.update(req.params.id, req.body);
    flash(req, 'success', 'Traffic source updated');
    res.redirect('/sources');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const item = { id: req.params.id, ...req.body, params: sources.paramsFromBody(req.body) };
    const triggers = await postbacks.list({ sourceId: req.params.id });
    res.status(err.status).render('sources/form', formLocals({ title: 'Edit traffic source', isNew: false, item, triggers, error: err.message }));
  }
});

sourcesRouter.post('/:id/delete', async (req, res) => {
  try {
    await sources.remove(req.params.id);
    flash(req, 'success', 'Traffic source deleted');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect('/sources');
});
