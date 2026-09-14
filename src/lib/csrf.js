import { randomToken } from './ids.js';

export function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = randomToken(16);
  return req.session.csrf;
}

/** Double-submit token: form posts must carry _csrf matching the session value. */
export function csrfProtect(req, res, next) {
  res.locals.csrfToken = csrfToken(req);
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!sent || sent !== req.session.csrf) {
    res.status(403);
    return res.render('error', { title: 'Forbidden', status: 403, message: 'Invalid or missing CSRF token. Go back and retry.' });
  }
  next();
}
