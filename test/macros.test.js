import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, buildCtx } from '../src/lib/macros.js';

test('render url-encodes and blanks unknown macros, case-insensitive', () => {
  const ctx = { clickid: 'abc 1', sub1: 'a&b' };
  assert.equal(render('https://x/?c={CLICKID}&s={sub1}&z={nope}', ctx), 'https://x/?c=abc%201&s=a%26b&z=');
});

test('render json mode escapes quotes', () => {
  assert.equal(render('{"a":"{v}"}', { v: 'say "hi"' }, 'json'), '{"a":"say \\"hi\\""}');
});

test('buildCtx maps click/conversion fields', () => {
  const ctx = buildCtx({
    click: { id: 'c1', externalId: 'e1', sub1: 's1', cost: 0.5, createdAt: 1000 },
    campaign: { id: 'camp', name: 'Camp', key: 'k' },
    offer: { id: 'o', name: 'O', payout: 2 },
    source: { id: 's', name: 'S' },
    conversion: { id: 'cv', status: 'sale', payout: 3.456, txid: 't', createdAt: 2000 },
  });
  assert.equal(ctx.clickid, 'c1');
  assert.equal(ctx.external_id, 'e1');
  assert.equal(ctx.payout, '3.46');
  assert.equal(ctx.status, 'sale');
  assert.equal(ctx.campaign_key, 'k');
  assert.equal(ctx.cost, '0.5');
  assert.equal(ctx.timestamp, '2000');
  const noConv = buildCtx({ click: { id: 'c1' }, offer: { payout: 2 } });
  assert.equal(noConv.payout, '2.00');
  assert.equal(noConv.status, '');
});
