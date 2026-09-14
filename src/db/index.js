import { JsonStore } from './jsonStore.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

let instance = null;

export function getDb() {
  if (instance) return instance;
  if (config.dbDriver === 'json') {
    instance = new JsonStore({ dir: config.dataDir, strict: config.dbStrict, logger });
    return instance;
  }
  throw new Error(`Unsupported DB_DRIVER '${config.dbDriver}' (json only; firestore comes later)`);
}

/** Test helper: swap the singleton. */
export function setDb(db) {
  instance = db;
}
