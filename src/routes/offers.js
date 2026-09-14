import { Router } from 'express';
import * as offers from '../services/offers.js';
import * as reports from '../services/reports.js';
import { parseRange } from '../lib/time.js';
import { flash, HttpError } from '../lib/http.js';
import { MACRO_LIST } from '../lib/macros.js';

export const offersRouter = Router();
const blank = { name: '', network: '', url: '', payout: 0, currency: 'USD', status: 'active' };

offersRouter.get('/', async (req, res) => {
  const rows = await offers.list();
  const today = parseRange({ preset: 'today' });
  const { rows: statRows } = await reports.aggregate({ from: today.from, to: today.to, groupBy: 'offerId' });
  res.render('offers/index', { title: 'Offers', rows, stats: new Map(statRows.map((r) => [r.key, r])) });
});

offersRouter.get('/new', (req, res) => {
  res.render('offers/form', { title: 'New offer', isNew: true, item: blank, statuses: offers.STATUSES, macroList: MACRO_LIST });
});

offersRouter.post('/', async (req, res) => {
  try {
    await offers.create(req.body);
    flash(req, 'success', 'Offer created');
    res.redirect('/offers');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    res.status(err.status).render('offers/form', { title: 'New offer', isNew: true, item: req.body, statuses: offers.STATUSES, macroList: MACRO_LIST, error: err.message });
  }
});

offersRouter.get('/:id', (req, res) => res.redirect(`/offers/${req.params.id}/edit`));

offersRouter.get('/:id/edit', async (req, res) => {
  const item = await offers.getById(req.params.id);
  if (!item) throw new HttpError(404, 'Offer not found');
  res.render('offers/form', { title: 'Edit offer', isNew: false, item, statuses: offers.STATUSES, macroList: MACRO_LIST });
});

offersRouter.post('/:id', async (req, res) => {
  try {
    await offers.update(req.params.id, req.body);
    flash(req, 'success', 'Offer updated');
    res.redirect('/offers');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    res.status(err.status).render('offers/form', { title: 'Edit offer', isNew: false, item: { id: req.params.id, ...req.body }, statuses: offers.STATUSES, macroList: MACRO_LIST, error: err.message });
  }
});

offersRouter.post('/:id/delete', async (req, res) => {
  try {
    await offers.remove(req.params.id);
    flash(req, 'success', 'Offer deleted');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    flash(req, 'error', err.message);
  }
  res.redirect('/offers');
});
