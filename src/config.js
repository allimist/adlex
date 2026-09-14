import path from 'node:path';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return v === '1' || v === 'true' || v === 'yes';
}

export const config = {
  isProd,
  port: Number(env.PORT) || 8080,
  baseUrl: (env.BASE_URL || `http://localhost:${Number(env.PORT) || 8080}`).replace(/\/+$/, ''),
  dbDriver: env.DB_DRIVER || 'json',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  dbStrict: bool(env.DB_STRICT, !isProd),
  sessionSecret: env.SESSION_SECRET || (isProd ? '' : 'dev-secret-not-for-production'),
  cookieSecure: bool(env.COOKIE_SECURE, false),
  trustProxy: Number(env.TRUST_PROXY) || 0,
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
  logClicks: bool(env.LOG_CLICKS, true),
};

export function assertProductionConfig() {
  if (!isProd) return;
  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    throw new Error('SESSION_SECRET (>=16 chars) is required when NODE_ENV=production');
  }
}
