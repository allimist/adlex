import { Router } from 'express';
import * as qa from '../services/qa.js';
import * as campaigns from '../services/campaigns.js';
import * as offers from '../services/offers.js';
import { config } from '../config.js';
import { flash, HttpError } from '../lib/http.js';

export const qaRouter = Router();

async function formLocals(extra) {
  const campaignList = (await campaigns.list()).filter((c) => c.status === 'active');
  const offerMap = await offers.mapById();
  // Warn about campaigns whose landing offers don't pass `se` to the site.
  const noTracking = new Set(
    campaignList.filter((c) => (c.offers || []).some((o) => offerMap.get(o.offerId) && !offerMap.get(o.offerId).appendTracking)).map((c) => c.id),
  );
  return { campaignList, noTracking, modes: qa.MODES, startAt: qa.START_AT, rateLimit: config.collectRatePerMin, running: qa.isRunning(), ...extra };
}

qaRouter.get('/', async (req, res) => {
  res.render('qa/index', await formLocals({ title: 'QA', item: { ...qa.DEFAULTS, ...(req.session.qaLast || {}) }, runs: await qa.listRuns() }));
});

qaRouter.post('/', async (req, res) => {
  try {
    const id = await qa.startRun(req.body);
    req.session.qaLast = qa.fromBody(req.body);
    res.redirect(`/qa/${id}`);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    res.status(err.status).render('qa/index', await formLocals({ title: 'QA', item: qa.fromBody(req.body), runs: await qa.listRuns(), error: err.message }));
  }
});

qaRouter.get('/:id', async (req, res) => {
  const run = await qa.getRun(req.params.id);
  if (!run) throw new HttpError(404, 'QA run not found');
  res.render('qa/show', { title: 'QA run', run, id: req.params.id, rateLimit: config.collectRatePerMin });
});

qaRouter.post('/:id/delete', async (req, res) => {
  try {
    const n = await qa.deleteRun(req.params.id);
    flash(req, 'success', `Deleted the run and ${n} test record(s)`);
    res.redirect('/qa');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    flash(req, 'error', err.message);
    res.redirect(`/qa/${req.params.id}`);
  }
});
