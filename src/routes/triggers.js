import { Router } from 'express';
import * as postbacks from '../services/postbacks.js';
import * as sources from '../services/sources.js';
import * as campaigns from '../services/campaigns.js';
import { flash, HttpError } from '../lib/http.js';
import { MACRO_LIST } from '../lib/macros.js';

export const triggersRouter = Router();
export const postbackLogsRouter = Router();

async function formLocals(extra) {
  return {
    sourceList: await sources.list(),
    campaignList: await campaigns.list(),
    events: postbacks.EVENTS,
    methods: postbacks.METHODS,
    bodyTypes: postbacks.BODY_TYPES,
    macroList: MACRO_LIST,
    ...extra,
  };
}

const blank = (q) => ({
  name: '',
  sourceId: q.sourceId || '',
  campaignId: q.campaignId || null,
  event: 'conversion',
  statuses: [],
  method: 'GET',
  url: '',
  bodyType: 'none',
  body: '',
  timeoutMs: 5000,
  retries: 2,
  enabled: true,
});

triggersRouter.get('/', async (req, res) => {
  const rows = await postbacks.list({ sourceId: req.query.sourceId, campaignId: req.query.campaignId });
  res.render('triggers/index', {
    title: 'Triggers',
    rows,
    sourceMap: await sources.mapById(),
    campaignMap: await campaigns.mapById(),
    sourceList: await sources.list(),
    filter: { sourceId: req.query.sourceId || '' },
  });
});

triggersRouter.get('/new', async (req, res) => {
  res.render('triggers/form', await formLocals({ title: 'New trigger', isNew: true, item: blank(req.query) }));
});

triggersRouter.post('/', async (req, res) => {
  try {
    await postbacks.create(req.body);
    flash(req, 'success', 'Trigger created');
    res.redirect('/triggers');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const item = { ...req.body, statuses: String(req.body.statuses || '').split(/[,\s]+/).filter(Boolean), enabled: !!req.body.enabled };
    res.status(err.status).render('triggers/form', await formLocals({ title: 'New trigger', isNew: true, item, error: err.message }));
  }
});

triggersRouter.get('/logs', async (req, res) => {
  const { rows, nextAfter } = await postbacks.listLogs({ triggerId: req.query.triggerId, clickId: req.query.clickId, after: req.query.after });
  const trigger = req.query.triggerId ? await postbacks.getById(req.query.triggerId) : null;
  res.render('triggers/logs', {
    title: 'Postback logs',
    rows,
    nextAfter,
    trigger,
    baseQuery: { triggerId: req.query.triggerId || '', clickId: req.query.clickId || '', after: req.query.after || '' },
  });
});

triggersRouter.get('/:id/edit', async (req, res) => {
  const item = await postbacks.getById(req.params.id);
  if (!item) throw new HttpError(404, 'Trigger not found');
  res.render('triggers/form', await formLocals({ title: 'Edit trigger', isNew: false, item }));
});

triggersRouter.post('/:id', async (req, res) => {
  try {
    await postbacks.update(req.params.id, req.body);
    flash(req, 'success', 'Trigger updated');
    res.redirect('/triggers');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const item = { id: req.params.id, ...req.body, statuses: String(req.body.statuses || '').split(/[,\s]+/).filter(Boolean), enabled: !!req.body.enabled };
    res.status(err.status).render('triggers/form', await formLocals({ title: 'Edit trigger', isNew: false, item, error: err.message }));
  }
});

triggersRouter.post('/:id/delete', async (req, res) => {
  await postbacks.remove(req.params.id);
  flash(req, 'success', 'Trigger deleted');
  res.redirect('/triggers');
});

triggersRouter.post('/:id/test', async (req, res) => {
  const item = await postbacks.getById(req.params.id);
  if (!item) throw new HttpError(404, 'Trigger not found');
  const rec = await postbacks.testFire(item);
  flash(req, rec.ok ? 'success' : 'error', rec.ok ? `Test fired: HTTP ${rec.statusCode}` : `Test failed: ${rec.error}`);
  res.redirect(`/triggers/logs?triggerId=${item.id}`);
});

postbackLogsRouter.post('/:id/retry', async (req, res) => {
  const log = await postbacks.getLog(req.params.id);
  if (!log) throw new HttpError(404, 'Log entry not found');
  const rec = await postbacks.retryLog(log);
  flash(req, rec.ok ? 'success' : 'error', rec.ok ? `Retry sent: HTTP ${rec.statusCode}` : `Retry failed: ${rec.error}`);
  res.redirect(`/triggers/logs?triggerId=${log.triggerId}`);
});
