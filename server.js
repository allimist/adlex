try {
  process.loadEnvFile('.env');
} catch {
  // no .env file: rely on real environment variables (Elastic Beanstalk sets them)
}

const { config, assertProductionConfig } = await import('./src/config.js');
assertProductionConfig();

const { logger } = await import('./src/lib/logger.js');
const { getDb } = await import('./src/db/index.js');
const { seedAdmin } = await import('./src/services/seed.js');
const { createApp } = await import('./src/app.js');

const db = getDb();
await seedAdmin();
const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ msg: 'listening', port: config.port, baseUrl: config.baseUrl, dataDir: config.dataDir, driver: config.dbDriver });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ msg: 'shutting down', signal });
  const timer = setTimeout(() => process.exit(1), 8000);
  await new Promise((r) => server.close(r));
  app.locals.sessionStore?.close();
  await db.close();
  clearTimeout(timer);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
