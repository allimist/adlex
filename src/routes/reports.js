import { Router } from 'express';
import { parseRange, PRESETS } from '../lib/time.js';
import * as reports from '../services/reports.js';
import * as campaigns from '../services/campaigns.js';
import * as offers from '../services/offers.js';
import * as sources from '../services/sources.js';

export const reportsRouter = Router();

reportsRouter.get('/', async (req, res) => {
  const range = parseRange(req.query);
  const group = reports.GROUPS.find(([k]) => k === req.query.group) || reports.GROUPS[0];
  const { rows, total } = await reports.aggregate({ from: range.from, to: range.to, groupBy: group[2] });
  const names = group[0] === 'campaigns' ? await campaigns.mapById() : group[0] === 'offers' ? await offers.mapById() : await sources.mapById();
  const entityBase = group[0] === 'campaigns' ? '/campaigns/' : group[0] === 'offers' ? '/offers/' : '/sources/';
  res.render('reports/index', {
    title: 'Reports',
    range,
    presets: PRESETS,
    groups: reports.GROUPS,
    group: group[0],
    rows,
    total,
    names,
    entityBase,
  });
});
