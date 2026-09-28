/**
 * Ingest worker for BUS_DRIVER=kafka: consumes tracking events from Kafka, writes them to the
 * database in batches, and retries postbacks that arrived before their click.
 * Run one or more alongside the web processes (consumers share the load via the consumer group).
 */
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file: rely on real environment variables
}

const { config } = await import('./src/config.js');
const { logger } = await import('./src/lib/logger.js');
const { getDb } = await import('./src/db/index.js');
const { getBus, closeBus } = await import('./src/bus/index.js');
const { applyEvents } = await import('./src/services/ingest.js');
const { startPendingLoop, stopPendingLoop } = await import('./src/services/conversions.js');

if (config.busDriver !== 'kafka') {
  logger.error({ msg: 'worker.js is only needed with BUS_DRIVER=kafka; with direct the web process ingests events itself' });
  process.exit(1);
}

const db = getDb();
const bus = getBus();
await bus.startConsumer(async (events) => {
  const r = await applyEvents(events);
  if (config.logClicks) logger.info({ msg: 'ingested', ...r });
});
startPendingLoop();
logger.info({ msg: 'worker started', bus: config.busDriver });

// A bug in background work (QA runs, trigger calls) must not take the tracker down.
process.on('unhandledRejection', (err) => logger.error({ msg: 'unhandled rejection', err: String((err && err.stack) || err).slice(0, 2000) }));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ msg: 'worker shutting down', signal });
  const timer = setTimeout(() => process.exit(1), 8000);
  stopPendingLoop();
  await closeBus();
  await db.close();
  clearTimeout(timer);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
