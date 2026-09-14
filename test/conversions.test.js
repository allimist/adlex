import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adlex-conv-'));
process.env.LOG_CLICKS = '0';
const { getDb } = await import('../src/db/index.js');
const { recordConversion, conversionId } = await import('../src/services/conversions.js');

const db = getDb();
before(async () => {
  await db.collection('sources').doc('s1').set({ name: 'S', params: {}, costModel: 'cpc' });
  await db.collection('offers').doc('o1').set({ name: 'O', payout: 2.5, url: 'https://x', status: 'active' });
  await db.collection('campaigns').doc('c1').set({ name: 'C', key: 'k1', sourceId: 's1', offers: [{ offerId: 'o1', weight: 100 }], postbackToken: '' });
  await db.collection('campaigns').doc('c2').set({ name: 'C2', key: 'k2', sourceId: 's1', offers: [], postbackToken: 'secret' });
  const base = { day: '2026-01-01', createdAt: 1000, sourceId: 's1', offerId: 'o1', externalId: 'E', cost: 0.01, converted: false, convertedAt: null, revenue: 0, ip: '1.1.1.1' };
  await db.collection('clicks').doc('CLK1').set({ ...base, campaignId: 'c1', campaignKey: 'k1' });
  await db.collection('clicks').doc('CLK2').set({ ...base, campaignId: 'c2', campaignKey: 'k2' });
});
after(() => db.close());

test('conversionId is deterministic', () => {
  assert.equal(conversionId('CLK1', 'tx'), conversionId('CLK1', 'tx'));
  assert.notEqual(conversionId('CLK1', 'tx'), conversionId('CLK1', 'tx2'));
  assert.equal(conversionId('CLK1', ''), 'cv_CLK1');
});

test('errors: missing / unknown clickid, bad token', async () => {
  assert.equal((await recordConversion({})).code, 400);
  assert.equal((await recordConversion({ clickid: 'nope' })).code, 404);
  assert.equal((await recordConversion({ clickid: 'CLK2', payout: 1 })).code, 403);
  assert.equal((await recordConversion({ clickid: 'CLK2', payout: 1, token: 'secret' })).text, 'OK');
});

test('txid dedupe, no-txid upsert, payout fallback, click revenue', async () => {
  let r = await recordConversion({ clickid: 'CLK1', txid: 'T1', status: 'sale', payout: '3.5' });
  assert.equal(r.text, 'OK');
  r = await recordConversion({ clickid: 'CLK1', txid: 'T1', status: 'sale', payout: '3.5' });
  assert.equal(r.text, 'DUPLICATE');

  r = await recordConversion({ clickid: 'CLK1' }); // no txid, no payout -> offer payout, status lead
  assert.equal(r.text, 'OK');
  assert.equal(r.conversion.payout, 2.5);
  assert.equal(r.conversion.status, 'lead');

  r = await recordConversion({ clickid: 'CLK1', status: 'SALE', payout: '5' });
  assert.equal(r.text, 'UPDATED');
  assert.equal(r.conversion.status, 'sale');

  const click = (await db.collection('clicks').doc('CLK1').get()).data();
  assert.equal(click.converted, true);
  assert.equal(click.revenue, 8.5); // 3.5 (T1) + 5 (upserted no-txid)

  r = await recordConversion({ clickid: 'CLK1', txid: 'T2', status: 'rejected', payout: '9' });
  assert.equal(r.text, 'OK');
  assert.equal((await db.collection('clicks').doc('CLK1').get()).data().revenue, 8.5); // rejected excluded
});
