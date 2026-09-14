import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { config } from './config.js';
import { helpers } from './lib/view.js';
import { flashMiddleware } from './lib/http.js';
import { csrfProtect } from './lib/csrf.js';
import { attachUser, requireAuth, requireAdmin, requireWriteRole } from './middleware/auth.js';
import { notFound, errorHandler } from './middleware/errors.js';
import { DbSessionStore } from './services/sessionStore.js';
import { publicRouter } from './routes/public.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { reportsRouter } from './routes/reports.js';
import { campaignsRouter } from './routes/campaigns.js';
import { offersRouter } from './routes/offers.js';
import { sourcesRouter } from './routes/sources.js';
import { triggersRouter, postbackLogsRouter } from './routes/triggers.js';
import { clicklogRouter } from './routes/clicklog.js';
import { conversionsRouter } from './routes/conversions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const NAV = [
  ['/reports', 'Reports'],
  ['/campaigns', 'Campaigns'],
  ['/offers', 'Offers'],
  ['/sources', 'Traffic sources'],
  ['/conversions', 'Conversions'],
  ['/clicklog', 'Clicklog'],
  ['/triggers', 'Triggers'],
  ['/users', 'Users', 'admin'],
];

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'views'));
  app.set('query parser', 'simple');
  Object.assign(app.locals, helpers, { nav: NAV, baseUrl: config.baseUrl, appName: 'adlex' });

  app.use(express.static(path.join(root, 'public'), { maxAge: config.isProd ? '1h' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  // Public tracking endpoints: no session, no CSRF, must stay fast.
  app.use(publicRouter);

  const sessionStore = new DbSessionStore({ ttlMs: SESSION_TTL_MS });
  app.use(
    session({
      name: 'adlex.sid',
      secret: config.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: SESSION_TTL_MS },
    }),
  );
  app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    next();
  });
  app.use(flashMiddleware);
  app.use(attachUser);
  app.use(csrfProtect);

  app.use(authRouter);

  app.use(requireAuth);
  app.use(requireWriteRole);
  app.get('/', (req, res) => res.redirect('/reports'));
  app.use('/reports', reportsRouter);
  app.use('/campaigns', campaignsRouter);
  app.use('/offers', offersRouter);
  app.use('/sources', sourcesRouter);
  app.use('/triggers', triggersRouter);
  app.use('/postback-logs', postbackLogsRouter);
  app.use('/clicklog', clicklogRouter);
  app.use('/conversions', conversionsRouter);
  app.use('/users', requireAdmin, usersRouter);

  app.use(notFound);
  app.use(errorHandler);
  app.locals.sessionStore = sessionStore;
  return app;
}
