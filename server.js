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
const { getBus, closeBus } = await import('./src/bus/index.js');
const { applyEvents } = await import('./src/services/ingest.js');
const { startPendingLoop, stopPendingLoop } = await import('./src/services/conversions.js');
const { markInterrupted } = await import('./src/services/qa.js');

const db = getDb();
await seedAdmin();
await markInterrupted();
const app = createApp();

// BUS_DRIVER=direct: this process buffers and writes events itself.
// BUS_DRIVER=kafka: the web process only produces; worker.js consumes (unless CONSUME_IN_WEB=1).
const bus = getBus();
if (config.consumeInWeb) {
  await bus.startConsumer(applyEvents);
  startPendingLoop();
}

const server = app.listen(config.port, () => {
  logger.info({ msg: 'listening', port: config.port, baseUrl: config.baseUrl, dataDir: config.dataDir, driver: config.dbDriver, bus: config.busDriver, consume: config.consumeInWeb });
});

// A bug in background work (QA runs, trigger calls) must not take the tracker down.
process.on('unhandledRejection', (err) => logger.error({ msg: 'unhandled rejection', err: String((err && err.stack) || err).slice(0, 2000) }));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ msg: 'shutting down', signal });
  const timer = setTimeout(() => process.exit(1), 8000);
  await new Promise((r) => server.close(r));
  stopPendingLoop();
  await closeBus();
  app.locals.sessionStore?.close();
  await db.close();
  clearTimeout(timer);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
