/** Session-backed flash messages and small response helpers. */
export function flash(req, type, message) {
  if (!req.session) return;
  req.session.flash = { type, message };
}

export function flashMiddleware(req, res, next) {
  res.locals.flash = null;
  if (req.session && req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
  next();
}

export function redirectBack(req, res, fallback = '/') {
  const ref = req.get('referer');
  res.redirect(ref && ref.startsWith(req.protocol + '://' + req.get('host')) ? ref : fallback);
}

/** Wrap an Express Router so thrown errors in async handlers reach the error handler (Express 5 does this natively). */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
