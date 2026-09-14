import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import * as users from './users.js';

/** Create the first admin from env if the users collection is empty. */
export async function seedAdmin() {
  if ((await users.count()) > 0) return false;
  if (!config.adminEmail || !config.adminPassword) {
    logger.warn({ msg: 'No users exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set; nobody can log in' });
    return false;
  }
  await users.create({ email: config.adminEmail, name: 'Admin', role: 'admin', password: config.adminPassword });
  logger.info({ msg: 'seeded admin user', email: config.adminEmail });
  return true;
}
