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

  // Event bus between the collector and the database: direct (in-process batching) | kafka
  busDriver: env.BUS_DRIVER || 'direct',
  busFlushMs: Number(env.BUS_FLUSH_MS) || 500,
  busBatch: Number(env.BUS_BATCH) || 500,
  // BUS_DRIVER=kafka: the web process only produces; run worker.js to consume. Set CONSUME_IN_WEB=1 to consume in the web process too.
  consumeInWeb: bool(env.CONSUME_IN_WEB, (env.BUS_DRIVER || 'direct') !== 'kafka'),
  kafka: {
    brokers: (env.KAFKA_BROKERS || 'localhost:9092').split(',').map((s) => s.trim()).filter(Boolean),
    clientId: env.KAFKA_CLIENT_ID || 'adlex',
    topic: env.KAFKA_TOPIC || 'adlex.events',
    groupId: env.KAFKA_GROUP || 'adlex-ingest',
    ssl: bool(env.KAFKA_SSL, false),
    saslMechanism: env.KAFKA_SASL_MECHANISM || '', // plain | scram-sha-256 | scram-sha-512
    saslUsername: env.KAFKA_SASL_USERNAME || '',
    saslPassword: env.KAFKA_SASL_PASSWORD || '',
  },

  // db.bestoffers.biz-compatible raw CSV dumps /se/export and /pc/export (?code=). Empty = disabled.
  legacyReportCode: env.LEGACY_REPORT_CODE || '',

  // Website collector (/se/, /pc/): requests per IP per minute
  collectRatePerMin: Number(env.COLLECT_RATE_PER_MIN) || 120,
};

export function assertProductionConfig() {
  if (!isProd) return;
  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    throw new Error('SESSION_SECRET (>=16 chars) is required when NODE_ENV=production');
  }
}
