/** Event bus between the tracking endpoints and the database. BUS_DRIVER=direct | kafka */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { DirectBus } from './direct.js';
import { KafkaBus } from './kafka.js';

let instance = null;
let fallback = null;

export function getBus() {
  if (instance) return instance;
  if (config.busDriver === 'direct') {
    instance = new DirectBus({ flushMs: config.busFlushMs, batchSize: config.busBatch, logger });
  } else if (config.busDriver === 'kafka') {
    // If Kafka is unreachable, write through a local direct buffer instead of losing the event.
    fallback = new DirectBus({ flushMs: config.busFlushMs, batchSize: config.busBatch, logger });
    import('../services/ingest.js').then(({ applyEvents }) => fallback.startConsumer(applyEvents));
    instance = new KafkaBus({ kafka: config.kafka, logger, onProduceError: (event) => fallback.publish(event) });
  } else {
    throw new Error(`Unsupported BUS_DRIVER '${config.busDriver}' (direct | kafka)`);
  }
  return instance;
}

export async function closeBus() {
  if (instance) await instance.close();
  if (fallback) await fallback.close();
}

/** Test helper: swap the singleton. */
export function setBus(bus) {
  instance = bus;
}
