import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOffer, readMappedParams, computeCost } from '../src/services/tracking.js';

test('pickOffer respects weights and status', () => {
  const offers = [
    { id: 'a', status: 'active', weight: 70 },
    { id: 'b', status: 'active', weight: 30 },
    { id: 'c', status: 'paused', weight: 100 },
    { id: 'd', status: 'active', weight: 0 },
  ];
  const counts = { a: 0, b: 0 };
  let seed = 1;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 10000; i++) counts[pickOffer(offers, rand).id]++;
  assert.ok(counts.a > 6500 && counts.a < 7500, `a=${counts.a}`);
  assert.ok(counts.b > 2500 && counts.b < 3500, `b=${counts.b}`);
  assert.equal(pickOffer([{ id: 'x', status: 'paused', weight: 5 }]), null);
  assert.equal(pickOffer([]), null);
  assert.equal(pickOffer(offers, () => 0.999999).id, 'b');
  assert.equal(pickOffer(offers, () => 0).id, 'a');
});

test('readMappedParams uses source param names and defaults', () => {
  const source = { params: { clickid: { name: 'cid', token: '' }, cost: { name: 'price', token: '' }, t1: { name: 'zone', token: '' } } };
  const q = { cid: 'X1', price: '0.02', zone: 'z9', t2: 'two', t17: 'seventeen', clickid: 'ignored' };
  const m = readMappedParams(q, source);
  assert.equal(m.externalId, 'X1');
  assert.equal(m.costRaw, '0.02');
  assert.equal(m.t.t1, 'z9');
  assert.equal(m.t.t2, 'two'); // unmapped keys fall back to their own name
  assert.equal(m.t.t17, 'seventeen'); // custom params up to t20
  assert.equal(m.t.t3, undefined); // empty values are not stored
  assert.equal(readMappedParams({ clickid: ['a', 'b'] }, null).externalId, 'a');
});

test('computeCost per cost model', () => {
  const campaign = { costPerClick: 0.05 };
  assert.equal(computeCost({ costModel: 'none' }, campaign, '1'), 0);
  assert.equal(computeCost({ costModel: 'cpc' }, campaign, '1'), 0.05);
  assert.equal(computeCost({ costModel: 'param' }, campaign, '0.012'), 0.012);
  assert.equal(computeCost({ costModel: 'param' }, campaign, 'abc'), 0.05);
  assert.equal(computeCost({ costModel: 'param' }, campaign, '-1'), 0.05);
  assert.equal(computeCost(null, campaign, ''), 0.05);
});
