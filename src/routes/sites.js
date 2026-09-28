import { Router } from 'express';
import * as sites from '../services/sites.js';
import * as sources from '../services/sources.js';
import { flash, HttpError } from '../lib/http.js';

export const sitesRouter = Router();

sitesRouter.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows = await sites.list();
  const total = rows.length;
  if (q) rows = rows.filter((s) => s.id.includes(q));
  res.render('sites/index', {
    title: 'Sites',
    rows: rows.slice(0, 500),
    total,
    shown: rows.length,
    q,
    sourceMap: await sources.mapById(),
    sourceList: await sources.list({ includeArchived: false }),
    result: req.session.sitesResult || null,
  });
  delete req.session.sitesResult;
});

sitesRouter.post('/', async (req, res) => {
  try {
    const r = await sites.addMany({ domains: req.body.domains, sourceId: req.body.sourceId, notes: req.body.notes });
    req.session.sitesResult = { added: r.added.length, skipped: r.skipped, invalid: r.invalid };
    flash(req, 'success', `Added ${r.added.length} site(s)`);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect('/sites');
});

sitesRouter.get('/:id/edit', async (req, res) => {
  const item = await sites.getById(req.params.id);
  if (!item) throw new HttpError(404, 'Site not found');
  res.render('sites/form', { title: `Site ${item.id}`, item, statuses: sites.STATUSES, sourceList: await sources.list() });
});

sitesRouter.post('/:id', async (req, res) => {
  try {
    await sites.update(req.params.id, req.body);
    flash(req, 'success', 'Site updated');
    res.redirect('/sites');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const item = { id: req.params.id, ...req.body };
    res.status(err.status).render('sites/form', { title: `Site ${item.id}`, item, statuses: sites.STATUSES, sourceList: await sources.list(), error: err.message });
  }
});

sitesRouter.post('/:id/delete', async (req, res) => {
  await sites.remove(req.params.id);
  flash(req, 'success', 'Site removed');
  res.redirect('/sites');
});
