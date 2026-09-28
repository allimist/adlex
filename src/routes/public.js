import { Router } from 'express';
import { handleClick } from '../services/tracking.js';
import { recordConversion } from '../services/conversions.js';
import { handleSession, handleLegacyEvent, handleBrandConversion, preflight } from '../services/collect.js';
import { BRANDCLICK_STATUS } from '../services/conversions.js';
import { serveExportByToken } from '../services/exports.js';
import { serveLegacyUpload, serveLegacyDump } from '../services/legacy.js';

export const publicRouter = Router();

publicRouter.get('/health', (req, res) => res.type('text').send('ok'));
publicRouter.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

publicRouter.get('/click/:campaignKey', handleClick);

async function postback(req, res) {
  const params = { ...(req.query || {}), ...(req.body || {}) };
  if (String(params.status || '').toLowerCase() === BRANDCLICK_STATUS) return handleBrandConversion(req, res, params);
  const result = await recordConversion(params, { ip: req.ip || '' });
  res.status(result.code).set('Cache-Control', 'no-store').type('text').send(result.text);
}
publicRouter.get('/postback', postback);
publicRouter.post('/postback', postback);
publicRouter.options('/postback', preflight);

// Website collector (replaces db.bestoffers.biz). Trailing slash optional: the CMS scripts call /se/ and /pc/?…
publicRouter.options(['/se', '/se/', '/pc', '/pc/'], preflight);
publicRouter.get(['/se', '/se/'], handleSession);
publicRouter.get(['/pc', '/pc/'], handleLegacyEvent);

// db.bestoffers.biz-compatible reads: offline-conversion feed and raw dumps.
publicRouter.get(['/pc/up', '/pc/up/'], serveLegacyUpload);
publicRouter.get(['/se/export', '/se/export/'], serveLegacyDump('se'));
publicRouter.get(['/pc/export', '/pc/export/'], serveLegacyDump('pc'));

// Offline-conversion CSV for Google Ads / Microsoft Ads scheduled imports.
publicRouter.get('/x/:token.csv', serveExportByToken);
