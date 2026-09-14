import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, compareValues } from '../src/db/query.js';

const entries = [
  { id: 'a', data: { n: 1, s: 'x', tags: ['p', 'q'], createdAt: 100 } },
  { id: 'b', data: { n: 2, s: 'y', tags: ['q'], createdAt: 200 } },
  { id: 'c', data: { n: 3, s: 'z', createdAt: 200 } },
  { id: 'd', data: { s: 'w', createdAt: 300 } }, // no n
];
const q = (patch) => ({ filters: [], orders: [], limit: undefined, startAfter: undefined, ...patch });
const ids = (rows) => rows.map((r) => r.id);

test('== and missing field excluded', () => {
  assert.deepEqual(ids(runQuery(entries, q({ filters: [['n', '==', 2]] }))), ['b']);
  assert.deepEqual(ids(runQuery(entries, q({ filters: [['n', '>=', 1]] }))), ['a', 'b', 'c']);
});

test('!= excludes missing field too (Firestore semantics)', () => {
  assert.deepEqual(ids(runQuery(entries, q({ filters: [['n', '!=', 2]] }))), ['a', 'c']);
});

test('in and array-contains', () => {
  assert.deepEqual(ids(runQuery(entries, q({ filters: [['s', 'in', ['x', 'w']]] }))), ['a', 'd']);
  assert.deepEqual(ids(runQuery(entries, q({ filters: [['tags', 'array-contains', 'q']] }))), ['a', 'b']);
});

test('orderBy desc with id tiebreak, missing orderBy field excluded', () => {
  const rows = runQuery(entries, q({ orders: [['createdAt', 'desc']] }));
  assert.deepEqual(ids(rows), ['d', 'b', 'c', 'a']);
  assert.deepEqual(ids(runQuery(entries, q({ orders: [['n', 'asc']] }))), ['a', 'b', 'c']);
});

test('startAfter with two-field cursor and limit', () => {
  const spec = q({ orders: [['createdAt', 'desc'], ['__name__', 'asc']], limit: 2 });
  const page1 = runQuery(entries, spec);
  assert.deepEqual(ids(page1), ['d', 'b']);
  const last = page1[1];
  const page2 = runQuery(entries, { ...spec, startAfter: [last.data.createdAt, last.id] });
  assert.deepEqual(ids(page2), ['c', 'a']);
});

test('strict mode rejects Firestore-invalid queries', () => {
  assert.throws(() => runQuery(entries, q({ filters: [['n', '>', 1], ['createdAt', '<', 5]] }), true), /Inequality/);
  assert.throws(
    () => runQuery(entries, q({ filters: [['n', '>', 1]], orders: [['createdAt', 'asc']] }), true),
    /First orderBy/,
  );
  assert.doesNotThrow(() => runQuery(entries, q({ filters: [['n', '>', 1]], orders: [['n', 'asc']] }), true));
  assert.throws(() => runQuery(entries, q({ filters: [['n', 'in', []]] }), true), /non-empty/);
});

test('compareValues type ranks', () => {
  assert.ok(compareValues(null, false) < 0);
  assert.ok(compareValues(true, 0) < 0);
  assert.ok(compareValues(5, 'a') < 0);
  assert.equal(compareValues('a', 'a'), 0);
});
