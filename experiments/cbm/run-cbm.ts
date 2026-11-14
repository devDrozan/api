import { createCbmProbe, CbmError } from './cbm-rates.js';
let requests = 0;
const probe = createCbmProbe({ fetcher: async (...args) => { requests++; return fetch(...args); } });
try {
  const first = await probe.get();
  const second = await probe.get();
  if (requests !== 2 || second.cache !== 'HIT' || first.retrievedAt !== second.retrievedAt) throw new Error('CACHE_VERIFICATION_FAILED');
  console.log(JSON.stringify({ experimentOnly: true, ...first, cacheVerification: { secondCall: second.cache, totalUpstreamRequests: requests, retrievalTimestampUnchanged: true },
    notes: ['Market and reference rates are distinct; the reference API is not a market-rate fallback.', 'KRW API unit is established by the matching official website row; normalization divides by 100 exactly.', 'No production endpoint, UI, contract, build or deployment change.'] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ experimentOnly: true, code: error instanceof CbmError ? error.code : 'CBM_TEST_FAILED', upstreamStatus: error instanceof CbmError ? error.upstreamStatus : undefined }));
  process.exitCode = 1;
}
