import { T_KEYS, tValue } from './tparams.js';

/** Macro rendering shared by offer URLs, campaign click URLs and outgoing postbacks. */
export const MACRO_LIST = [
  ['clickid', 'Our click id (use this in offer URLs and postbacks to us)'],
  ['external_id', "Traffic source's click id (from the mapped clickid param)"],
  ['campaign_id', 'Campaign id'],
  ['campaign_name', 'Campaign name'],
  ['campaign_key', 'Campaign key used in the click URL'],
  ['source_id', 'Traffic source id'],
  ['source_name', 'Traffic source name'],
  ['offer_id', 'Offer id'],
  ['offer_name', 'Offer name'],
  ['payout', 'Conversion payout (2 decimals)'],
  ['cost', 'Click cost'],
  ['status', 'Conversion status (lead, sale, rejected...)'],
  ['txid', 'Transaction id from the network postback'],
  ['conversion_id', 'Our conversion id'],
  ...T_KEYS.map((k) => [k, `Custom traffic source param ${k}`]),
  ['gclid', 'Google click id (website clicks)'],
  ['msclkid', 'Microsoft click id (website clicks)'],
  ['fbclid', 'Facebook click id (website clicks)'],
  ['ad_click_id', 'Ad platform click id, whichever type'],
  ['ad_click_type', 'gclid | msclkid | fbclid | wbraid | gbraid'],
  ['brand', 'Last brand clicked on the website'],
  ['event_name', 'Event name from the postback (event_name param)'],
  ['domain', 'Website domain'],
  ['page_url', 'Website landing page'],
  ['ip', 'Visitor IP'],
  ['country', 'Visitor country (ISO-2, if known)'],
  ['ua', 'Visitor user agent'],
  ['referer', 'Referer'],
  ['timestamp', 'Event time in ms'],
  ['date', 'Event date YYYY-MM-DD'],
];

const RE = /\{([a-z0-9_]+)\}/gi;

function encodeFor(mode, v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (mode === 'url') return encodeURIComponent(s);
  if (mode === 'json') return JSON.stringify(s).slice(1, -1);
  return s;
}

/** Replace {macro} tokens; unknown macros become ''. mode: 'url' | 'json' | 'none' */
export function render(template, ctx, mode = 'url') {
  if (!template) return '';
  return String(template).replace(RE, (_, name) => encodeFor(mode, ctx[name.toLowerCase()]));
}

/** Render a form body "k={a}&k2={b}" by url-encoding each value. */
export function renderForm(template, ctx) {
  return render(template, ctx, 'url');
}

export function buildCtx({ click = {}, campaign = {}, offer = {}, source = {}, conversion = null, now = Date.now() }) {
  const ctx = {
    clickid: click.id || '',
    external_id: click.externalId || '',
    campaign_id: campaign.id || click.campaignId || '',
    campaign_name: campaign.name || '',
    campaign_key: campaign.key || click.campaignKey || '',
    source_id: source.id || click.sourceId || '',
    source_name: source.name || '',
    offer_id: offer.id || click.offerId || '',
    offer_name: offer.name || '',
    payout: conversion ? Number(conversion.payout || 0).toFixed(2) : Number(offer.payout || 0).toFixed(2),
    cost: click.cost !== undefined ? String(click.cost) : '',
    status: conversion ? conversion.status || '' : '',
    txid: conversion ? conversion.txid || '' : '',
    conversion_id: conversion ? conversion.id || '' : '',
    ip: click.ip || '',
    country: click.country || '',
    ua: click.ua || '',
    referer: click.referer || '',
    timestamp: String(conversion ? conversion.createdAt || now : click.createdAt || now),
    date: new Date(conversion ? conversion.createdAt || now : click.createdAt || now).toISOString().slice(0, 10),
  };
  for (const k of T_KEYS) ctx[k] = tValue(click, k);
  const adType = click.adClickType || '';
  const adId = click.adClickId || '';
  ctx.ad_click_id = adId;
  ctx.ad_click_type = adType;
  ctx.gclid = adType === 'gclid' ? adId : '';
  ctx.msclkid = adType === 'msclkid' ? adId : '';
  ctx.fbclid = adType === 'fbclid' ? adId : '';
  ctx.brand = (conversion && conversion.brand) || click.lastBrand || '';
  ctx.event_name = (conversion && conversion.eventName) || '';
  ctx.domain = click.domain || '';
  ctx.page_url = click.pageUrl || '';
  // Old templates may still say {sub1}…{sub5}; keep them working as aliases of t1…t5.
  for (let i = 1; i <= 5; i++) ctx[`sub${i}`] = ctx[`t${i}`];
  return ctx;
}
