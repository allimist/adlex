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
  ['sub1', 'Sub id 1'],
  ['sub2', 'Sub id 2'],
  ['sub3', 'Sub id 3'],
  ['sub4', 'Sub id 4'],
  ['sub5', 'Sub id 5'],
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
    sub1: click.sub1 || '',
    sub2: click.sub2 || '',
    sub3: click.sub3 || '',
    sub4: click.sub4 || '',
    sub5: click.sub5 || '',
    ip: click.ip || '',
    country: click.country || '',
    ua: click.ua || '',
    referer: click.referer || '',
    timestamp: String(conversion ? conversion.createdAt || now : click.createdAt || now),
    date: new Date(conversion ? conversion.createdAt || now : click.createdAt || now).toISOString().slice(0, 10),
  };
  return ctx;
}
