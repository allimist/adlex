import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { config } from '../config.js';
import * as sites from '../services/sites.js';
import * as campaigns from '../services/campaigns.js';

export const integrationRouter = Router();

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'integration');
export const SNIPPETS = [
  ['session', 'Script 1 — session', 'session.html'],
  ['links', 'Script 2 — link tokens', 'link-tokens.html'],
  ['brand', 'Script 3 — brand clicks', 'brand-click.html'],
];

/** The copy-paste scripts, with this AdLex's public address filled in. */
export function snippet(file, baseUrl = config.baseUrl) {
  return fs.readFileSync(path.join(dir, file), 'utf8').replace(/__ADLEX_URL__/g, baseUrl);
}

integrationRouter.get('/', async (req, res) => {
  const siteList = await sites.list({ includeArchived: false });
  const campaignList = (await campaigns.list()).filter((c) => c.status === 'active');
  res.render('integration/index', {
    title: 'Integration',
    snippets: SNIPPETS.map(([id, label, file]) => ({ id, label, code: snippet(file) })),
    siteCount: siteList.length,
    exampleCampaign: campaignList[0] || null,
  });
});
