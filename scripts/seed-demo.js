/** Creates a demo traffic source, two offers, a campaign and a trigger. Idempotent by name.
 *  Run with the server stopped: the JSON store is per-process. */
try { process.loadEnvFile('.env'); } catch { /* env from environment */ }
const { config } = await import('../src/config.js');
const { getDb } = await import('../src/db/index.js');
const { toList } = await import('../src/db/adapter.js');
const sources = await import('../src/services/sources.js');
const offers = await import('../src/services/offers.js');
const campaigns = await import('../src/services/campaigns.js');
const postbacks = await import('../src/services/postbacks.js');
const { seedAdmin } = await import('../src/services/seed.js');

const db = getDb();
await seedAdmin();

async function findByName(collection, name) {
  return toList(await db.collection(collection).get()).find((r) => r.name === name) || null;
}

const preset = sources.PRESETS.propellerads;
let source = await findByName('sources', 'Demo PropellerAds');
if (!source) {
  const body = { name: 'Demo PropellerAds', costModel: preset.costModel, status: 'active', notes: 'Created by scripts/seed-demo.js' };
  for (const [k, p] of Object.entries(preset.params)) {
    body[`param_name_${k}`] = p.name;
    body[`param_token_${k}`] = p.token;
  }
  source = await sources.create(body);
}

let offerA = await findByName('offers', 'Demo Offer A');
if (!offerA) offerA = await offers.create({ name: 'Demo Offer A', network: 'httpbin', url: 'https://httpbin.org/get?cid={clickid}&s1={t1}', payout: 2.5, currency: 'USD', status: 'active' });
let offerB = await findByName('offers', 'Demo Offer B');
if (!offerB) offerB = await offers.create({ name: 'Demo Offer B', network: 'httpbin', url: 'https://httpbin.org/anything?click={clickid}', payout: 1, currency: 'USD', status: 'active' });

let campaign = await findByName('campaigns', 'Demo Campaign');
if (!campaign) {
  campaign = await campaigns.create({
    name: 'Demo Campaign',
    sourceId: source.id,
    status: 'active',
    costPerClick: 0.01,
    offerId: [offerA.id, offerB.id],
    weight: [70, 30],
  });
}

if (!(await findByName('triggers', 'Demo S2S postback'))) {
  await postbacks.create({
    name: 'Demo S2S postback',
    sourceId: source.id,
    event: 'conversion',
    method: 'GET',
    url: 'https://httpbin.org/get?visitor_id={external_id}&payout={payout}&status={status}',
    bodyType: 'none',
    timeoutMs: 5000,
    retries: 2,
    enabled: '1',
  });
}

await db.close();
console.log('Seeded.');
console.log('Click URL :', campaigns.buildClickUrl(campaign, source));
console.log('Example   :', `${config.baseUrl}/click/${campaign.key}?clickid=EXT123&cost=0.012&t1=zone9`);
console.log('Postback  :', campaigns.postbackUrl(campaign));
