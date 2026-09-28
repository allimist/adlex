import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, buildCtx } from '../src/lib/macros.js';

test('render url-encodes and blanks unknown macros, case-insensitive', () => {
  const ctx = { clickid: 'abc 1', t1: 'a&b' };
  assert.equal(render('https://x/?c={CLICKID}&s={t1}&z={nope}', ctx), 'https://x/?c=abc%201&s=a%26b&z=');
});

test('render json mode escapes quotes', () => {
  assert.equal(render('{"a":"{v}"}', { v: 'say "hi"' }, 'json'), '{"a":"say \\"hi\\""}');
});

test('buildCtx maps click/conversion fields', () => {
  const ctx = buildCtx({
    click: { id: 'c1', externalId: 'e1', sub1: 's1', t12: 'x12', cost: 0.5, createdAt: 1000 },
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
  assert.equal(ctx.t1, 's1'); // legacy sub1 on old clicks reads as t1
  assert.equal(ctx.sub1, 's1'); // {sub1} stays an alias of {t1}
  assert.equal(ctx.t12, 'x12');
  assert.equal(ctx.t20, '');
  const noConv = buildCtx({ click: { id: 'c1' }, offer: { payout: 2 } });
  assert.equal(noConv.payout, '2.00');
  assert.equal(noConv.status, '');
});

test('source params: legacy sub keys normalize, form keeps t1–t5 and only filled t6–t20', async () => {
  const { normalizeSourceParams, activeTKeys } = await import('../src/lib/tparams.js');
  const { paramsFromBody } = await import('../src/services/sources.js');
  const n = normalizeSourceParams({ clickid: { name: 'cid', token: '' }, sub1: { name: 'zone', token: '${ZONEID}' } });
  assert.deepEqual(Object.keys(n), ['clickid', 't1']);
  assert.equal(n.t1.name, 'zone');
  const p = paramsFromBody({ param_name_t1: 'zone', param_token_t8: '{{x}}', param_name_t9: '' });
  assert.ok(p.t5 && !p.t6 && !p.t9);
  assert.deepEqual(p.t8, { name: 't8', token: '{{x}}', hideInUrl: false });
  assert.equal(activeTKeys(p).length, 8);
  assert.equal(activeTKeys({}).length, 5);
});
