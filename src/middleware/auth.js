import * as users from '../services/users.js';

export async function attachUser(req, res, next) {
  res.locals.user = null;
  if (req.session && req.session.userId) {
    const user = await users.getById(req.session.userId);
    if (user && !user.disabled) {
      req.user = user;
      res.locals.user = user;
    } else {
      req.session.userId = null;
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET' && req.accepts('html') && !req.originalUrl.startsWith('/favicon')) req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

export function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).render('error', { title: 'Forbidden', status: 403, message: 'Admin role required.' });
}

/** Non-admins are read-only: every non-GET request under the app is refused. */
export function requireWriteRole(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.path === '/logout') return next();
  return requireAdmin(req, res, next);
}
