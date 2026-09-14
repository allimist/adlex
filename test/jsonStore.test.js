import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/db/jsonStore.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adlex-test-'));
}

test('set/get/update/delete/create semantics', async () => {
  const dir = tmpDir();
  const db = new JsonStore({ dir, strict: true });
  const users = db.collection('users');
  await users.doc('u1').set({ name: 'A', n: 1 });
  let snap = await users.doc('u1').get();
  assert.equal(snap.exists, true);
  assert.deepEqual(snap.data(), { name: 'A', n: 1 });

  await users.doc('u1').update({ n: 2 });
  assert.equal((await users.doc('u1').get()).data().n, 2);

  await users.doc('u1').set({ extra: true }, { merge: true });
  assert.deepEqual((await users.doc('u1').get()).data(), { name: 'A', n: 2, extra: true });

  await assert.rejects(users.doc('u1').create({}), (e) => e.code === 'already-exists');
  await assert.rejects(users.doc('nope').update({}), (e) => e.code === 'not-found');

  await users.doc('u1').delete();
  assert.equal((await users.doc('u1').get()).exists, false);
  await users.doc('nope').delete(); // no-op

  const ref = await users.add({ name: 'B' });
  assert.equal(ref.id.length, 26);
  await db.close();
});

test('data() returns copies, not references', async () => {
  const db = new JsonStore({ dir: tmpDir() });
  const c = db.collection('c');
  const input = { arr: [1] };
  await c.doc('x').set(input);
  input.arr.push(2);
  const d = (await c.doc('x').get()).data();
  assert.deepEqual(d.arr, [1]);
  d.arr.push(3);
  assert.deepEqual((await c.doc('x').get()).data().arr, [1]);
  await db.close();
});

test('query chain and batch', async () => {
  const db = new JsonStore({ dir: tmpDir(), strict: true });
  const clicks = db.collection('clicks');
  for (let i = 0; i < 5; i++) {
    await clicks.doc(`c${i}`).set({ campaignId: i % 2 ? 'A' : 'B', createdAt: 1000 + i, converted: false });
  }
  const qs = await clicks.where('campaignId', '==', 'A').orderBy('createdAt', 'desc').limit(1).get();
  assert.equal(qs.size, 1);
  assert.equal(qs.docs[0].id, 'c3');

  const b = db.batch();
  b.update(clicks.doc('c0'), { converted: true }).set(db.collection('conversions').doc('cv1'), { clickId: 'c0' });
  await b.commit();
  assert.equal((await clicks.doc('c0').get()).data().converted, true);
  assert.equal((await db.collection('conversions').doc('cv1').get()).exists, true);

  // A batch with a bad update must not apply anything.
  const bad = db.batch();
  bad.set(clicks.doc('c9'), { x: 1 }).update(clicks.doc('missing'), { y: 1 });
  await assert.rejects(bad.commit(), (e) => e.code === 'not-found');
  assert.equal((await clicks.doc('c9').get()).exists, false);
  await db.close();
});

test('persists to disk atomically and reloads', async () => {
  const dir = tmpDir();
  let db = new JsonStore({ dir });
  await db.collection('offers').doc('o1').set({ name: 'Offer' });
  await db.collection('offers').doc('o2').set({ name: 'Other' });
  await db.close();

  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['offers.json']);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'offers.json'), 'utf8'));
  assert.equal(Object.keys(parsed.docs).length, 2);

  db = new JsonStore({ dir });
  const qs = await db.collection('offers').get();
  assert.equal(qs.size, 2);
  await assert.rejects(db.collection('offers').doc('o3').set({}).then(() => db.close()).then(() => db.collection('x').doc('y').set({})));
});

test('debounced flush writes without explicit close', async () => {
  const dir = tmpDir();
  const db = new JsonStore({ dir });
  await db.collection('t').doc('a').set({ v: 1 });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(fs.existsSync(path.join(dir, 't.json')));
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0);
  await db.close();
});
