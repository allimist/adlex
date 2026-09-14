/** Triggers = outgoing postbacks fired on conversion (or click) events. */
import { getDb } from '../db/index.js';
import { toList, toObj } from '../db/adapter.js';
import { HttpError } from '../lib/http.js';
import { render, renderForm, buildCtx } from '../lib/macros.js';
import { logger } from '../lib/logger.js';
import { pageNewestFirst } from './clicks.js';

const col = () => getDb().collection('triggers');
const logs = () => getDb().collection('postback_logs');

export const EVENTS = ['conversion', 'click'];
export const METHODS = ['GET', 'POST'];
export const BODY_TYPES = ['none', 'form', 'json'];
const BACKOFF_MS = [2000, 10000];
const MAX_CONCURRENT = 20;
let inFlight = 0;
const queue = [];

export async function list({ sourceId, campaignId } = {}) {
  let rows = toList(await col().get());
  if (sourceId) rows = rows.filter((r) => r.sourceId === sourceId);
  if (campaignId) rows = rows.filter((r) => r.campaignId === campaignId);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getById(id) {
  return toObj(await col().doc(id).get());
}

function fromBody(body) {
  const statuses = String(body.statuses || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    name: String(body.name || '').trim(),
    sourceId: String(body.sourceId || ''),
    campaignId: body.campaignId ? String(body.campaignId) : null,
    event: body.event || 'conversion',
    statuses,
    method: (body.method || 'GET').toUpperCase(),
    url: String(body.url || '').trim(),
    bodyType: body.bodyType || 'none',
    body: String(body.body || ''),
    timeoutMs: Math.min(30000, Math.max(500, Number(body.timeoutMs) || 5000)),
    retries: Math.min(5, Math.max(0, Math.round(Number(body.retries) || 0))),
    enabled: !!body.enabled,
  };
}

async function validate(data) {
  if (!data.name || data.name.length > 80) throw new HttpError(400, 'Name is required (max 80 chars)');
  if (!data.sourceId || !(await getDb().collection('sources').doc(data.sourceId).get()).exists) {
    throw new HttpError(400, 'Traffic source is required');
  }
  if (data.campaignId) {
    const c = toObj(await getDb().collection('campaigns').doc(data.campaignId).get());
    if (!c) throw new HttpError(400, 'Unknown campaign');
    if (c.sourceId !== data.sourceId) throw new HttpError(400, 'Campaign does not belong to the selected traffic source');
  }
  if (!EVENTS.includes(data.event)) throw new HttpError(400, 'Invalid event');
  if (!METHODS.includes(data.method)) throw new HttpError(400, 'Invalid method');
  if (!BODY_TYPES.includes(data.bodyType)) throw new HttpError(400, 'Invalid body type');
  if (!/^https?:\/\/.+/i.test(data.url)) throw new HttpError(400, 'URL must start with http:// or https://');
}

export async function create(body) {
  const data = fromBody(body);
  await validate(data);
  const now = Date.now();
  const ref = await col().add({ ...data, createdAt: now, updatedAt: now });
  return getById(ref.id);
}

export async function update(id, body) {
  if (!(await getById(id))) throw new HttpError(404, 'Trigger not found');
  const data = fromBody(body);
  await validate(data);
  await col().doc(id).update({ ...data, updatedAt: Date.now() });
  return getById(id);
}

export async function remove(id) {
  await col().doc(id).delete();
}

/** Campaign-scoped triggers override source-level ones for the same (source, event). */
export async function resolveTriggers(event, click) {
  const qs = await col().where('sourceId', '==', click.sourceId).where('event', '==', event).where('enabled', '==', true).get();
  const all = toList(qs);
  const forCampaign = all.filter((t) => t.campaignId && t.campaignId === click.campaignId);
  return forCampaign.length ? forCampaign : all.filter((t) => !t.campaignId);
}

/** Triggers that would fire for a campaign (for display on the campaign page). */
export async function effectiveForCampaign(campaign) {
  const all = await list({ sourceId: campaign.sourceId });
  const out = [];
  for (const event of EVENTS) {
    const ev = all.filter((t) => t.event === event && t.enabled);
    const own = ev.filter((t) => t.campaignId === campaign.id);
    out.push(...(own.length ? own : ev.filter((t) => !t.campaignId)));
  }
  return out;
}

function resolveRequest(trigger, ctx) {
  const url = render(trigger.url, ctx, 'url');
  let body = '';
  const headers = {};
  if (trigger.method === 'POST' && trigger.bodyType === 'form') {
    body = renderForm(trigger.body, ctx);
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (trigger.method === 'POST' && trigger.bodyType === 'json') {
    body = render(trigger.body, ctx, 'json');
    headers['content-type'] = 'application/json';
  }
  return { url, body, headers };
}

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      inFlight++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          inFlight--;
          const next = queue.shift();
          if (next) next();
        });
    };
    if (inFlight < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

async function attemptOnce(trigger, req) {
  const started = Date.now();
  const rec = { ok: false, statusCode: null, response: '', error: '', durationMs: 0 };
  try {
    const res = await fetch(req.url, {
      method: trigger.method,
      headers: { 'user-agent': 'adlex-postback/1.0', ...req.headers },
      body: trigger.method === 'POST' ? req.body : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(trigger.timeoutMs || 5000),
    });
    rec.statusCode = res.status;
    rec.ok = res.ok;
    rec.response = (await res.text().catch(() => '')).slice(0, 500);
    if (!res.ok) rec.error = `HTTP ${res.status}`;
  } catch (err) {
    rec.error = err && err.name === 'TimeoutError' ? 'TimeoutError' : String((err && err.cause && err.cause.message) || (err && err.message) || err);
  }
  rec.durationMs = Date.now() - started;
  return rec;
}

function shouldRetry(rec) {
  if (rec.ok) return false;
  if (rec.statusCode === null) return true; // network error / timeout
  return rec.statusCode >= 500 || rec.statusCode === 429;
}

async function writeLog(trigger, meta, req, attempt, rec) {
  await logs().add({
    createdAt: Date.now(),
    triggerId: trigger.id,
    triggerName: trigger.name,
    event: trigger.event,
    clickId: meta.clickId || '',
    conversionId: meta.conversionId || '',
    campaignId: meta.campaignId || '',
    sourceId: meta.sourceId || '',
    method: trigger.method,
    url: req.url,
    body: req.body || '',
    attempt,
    ...rec,
  });
}

/** Fire one trigger with retries; every attempt is logged. Resolves to the last attempt record. */
export async function fire(trigger, ctx, meta = {}) {
  const req = resolveRequest(trigger, ctx);
  const attempts = (trigger.retries || 0) + 1;
  let rec;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    rec = await withSlot(() => attemptOnce(trigger, req));
    await writeLog(trigger, meta, req, attempt, rec);
    if (!shouldRetry(rec) || attempt === attempts) break;
    await new Promise((r) => setTimeout(r, BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]));
  }
  return rec;
}

export async function fireForEvent(event, { click, campaign, offer, source, conversion }) {
  if (!click || !click.sourceId) return;
  const triggers = await resolveTriggers(event, click);
  if (triggers.length === 0) return;
  const applicable = triggers.filter(
    (t) => event !== 'conversion' || !t.statuses || t.statuses.length === 0 || t.statuses.includes(conversion.status),
  );
  const ctx = buildCtx({ click, campaign, offer, source, conversion });
  const meta = { clickId: click.id, conversionId: conversion ? conversion.id : '', campaignId: click.campaignId, sourceId: click.sourceId };
  await Promise.all(
    applicable.map((t) => fire(t, ctx, meta).catch((err) => logger.error({ msg: 'trigger error', trigger: t.id, err: String(err) }))),
  );
}

/** Fire with a synthetic context so the operator can check the URL template. */
export async function testFire(trigger) {
  const now = Date.now();
  const click = {
    id: 'test_' + now.toString(36),
    externalId: 'EXT-TEST',
    campaignId: trigger.campaignId || '',
    sourceId: trigger.sourceId,
    offerId: '',
    cost: 0.01,
    sub1: 'sub1',
    sub2: 'sub2',
    sub3: 'sub3',
    sub4: 'sub4',
    sub5: 'sub5',
    ip: '127.0.0.1',
    country: 'US',
    ua: 'test',
    referer: '',
    createdAt: now,
  };
  const conversion = { id: 'cv_test', status: 'sale', payout: 1, txid: 'TX-TEST', createdAt: now };
  const ctx = buildCtx({ click, conversion, campaign: {}, offer: {}, source: {} });
  return fire(trigger, ctx, { clickId: 'test', conversionId: 'cv_test', campaignId: click.campaignId, sourceId: click.sourceId });
}

export async function listLogs({ triggerId, clickId, after }) {
  return pageNewestFirst('postback_logs', { equals: { triggerId, clickId }, after });
}

export async function getLog(id) {
  return toObj(await logs().doc(id).get());
}

/** Re-send one logged request as-is (new log row). */
export async function retryLog(log) {
  const trigger = (await getById(log.triggerId)) || { id: log.triggerId, name: log.triggerName, event: log.event, method: log.method, timeoutMs: 5000, retries: 0 };
  const headers = {};
  if (log.method === 'POST' && log.body) {
    headers['content-type'] = log.body.trim().startsWith('{') ? 'application/json' : 'application/x-www-form-urlencoded';
  }
  const req = { url: log.url, body: log.body, headers };
  const rec = await withSlot(() => attemptOnce({ ...trigger, method: log.method }, req));
  await writeLog({ ...trigger, method: log.method }, log, req, (log.attempt || 0) + 1, rec);
  return rec;
}
