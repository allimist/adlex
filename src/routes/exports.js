import { Router } from 'express';
import * as exportsSvc from '../services/exports.js';
import * as sources from '../services/sources.js';
import { flash, HttpError } from '../lib/http.js';
import { MACRO_LIST } from '../lib/macros.js';

export const exportsRouter = Router();

async function formLocals(extra) {
  return {
    platforms: exportsSvc.PLATFORMS,
    windowTypes: exportsSvc.WINDOW_TYPES,
    months: exportsSvc.MONTHS,
    sourceList: await sources.list(),
    macroList: MACRO_LIST,
    ...extra,
  };
}

const blank = { platform: 'google_ads', enabled: true, includePayout: true, currency: 'USD', utcOffset: '+0000', windowType: 'rolling', windowDays: 2, month: 'previous', sourceIds: [], siteIds: [], statuses: [] };

exportsRouter.get('/', async (req, res) => {
  const rows = await exportsSvc.listExports();
  res.render('exports/index', { title: 'Exports', rows, platforms: exportsSvc.PLATFORMS });
});

exportsRouter.get('/new', async (req, res) => {
  res.render('exports/form', await formLocals({ title: 'New export', isNew: true, item: blank }));
});

exportsRouter.post('/', async (req, res) => {
  try {
    const e = await exportsSvc.create(req.body);
    flash(req, 'success', 'Export created');
    res.redirect(`/exports/${e.id}`);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    res.status(err.status).render('exports/form', await formLocals({ title: 'New export', isNew: true, item: exportsSvc.fromBody(req.body), error: err.message }));
  }
});

exportsRouter.get('/:id', async (req, res) => {
  const item = await exportsSvc.getById(req.params.id);
  if (!item) throw new HttpError(404, 'Export not found');
  const preview = await exportsSvc.toCsv(item, { limit: 20 });
  res.render('exports/show', {
    title: item.name,
    item,
    platforms: exportsSvc.PLATFORMS,
    range: exportsSvc.windowRange(item),
    preview,
    logs: await exportsSvc.listLogs(item.id),
    feedUrl: `${baseUrlOf(req)}/x/${item.token}.csv`,
  });
});

exportsRouter.get('/:id/edit', async (req, res) => {
  const item = await exportsSvc.getById(req.params.id);
  if (!item) throw new HttpError(404, 'Export not found');
  res.render('exports/form', await formLocals({ title: 'Edit export', isNew: false, item }));
});

exportsRouter.post('/:id', async (req, res) => {
  try {
    await exportsSvc.update(req.params.id, req.body);
    flash(req, 'success', 'Export saved');
    res.redirect(`/exports/${req.params.id}`);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const item = { id: req.params.id, ...exportsSvc.fromBody(req.body) };
    res.status(err.status).render('exports/form', await formLocals({ title: 'Edit export', isNew: false, item, error: err.message }));
  }
});

exportsRouter.get('/:id/download', async (req, res) => {
  const item = await exportsSvc.getById(req.params.id);
  if (!item) throw new HttpError(404, 'Export not found');
  await exportsSvc.sendCsv(item, req, res, 'download');
});

exportsRouter.post('/:id/rotate', async (req, res) => {
  await exportsSvc.rotateToken(req.params.id);
  flash(req, 'success', 'New URL generated. Update it in the ad platform.');
  res.redirect(`/exports/${req.params.id}`);
});

exportsRouter.post('/:id/delete', async (req, res) => {
  await exportsSvc.remove(req.params.id);
  flash(req, 'success', 'Export deleted');
  res.redirect('/exports');
});

function baseUrlOf(req) {
  return req.app.locals.baseUrl;
}
