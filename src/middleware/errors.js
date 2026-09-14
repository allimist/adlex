import { logger } from '../lib/logger.js';
import { config } from '../config.js';

export function notFound(req, res) {
  res.status(404);
  if (req.accepts('html')) return res.render('error', { title: 'Not found', status: 404, message: 'Page not found.' });
  res.type('text').send('Not found');
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status || (err.code === 'not-found' ? 404 : 500);
  if (status >= 500) logger.error({ msg: 'unhandled', path: req.originalUrl, err: err.stack || String(err) });
  res.status(status);
  const message = status >= 500 && config.isProd ? 'Internal server error.' : err.message;
  if (req.accepts('html')) return res.render('error', { title: 'Error', status, message });
  res.type('text').send(message);
}
