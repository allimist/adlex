import { Router } from 'express';
import { handleClick } from '../services/tracking.js';
import { recordConversion } from '../services/conversions.js';

export const publicRouter = Router();

publicRouter.get('/health', (req, res) => res.type('text').send('ok'));
publicRouter.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

publicRouter.get('/click/:campaignKey', handleClick);

async function postback(req, res) {
  const params = { ...(req.query || {}), ...(req.body || {}) };
  const result = await recordConversion(params, { ip: req.ip || '' });
  res.status(result.code).set('Cache-Control', 'no-store').type('text').send(result.text);
}
publicRouter.get('/postback', postback);
publicRouter.post('/postback', postback);
