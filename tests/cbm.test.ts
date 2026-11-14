import { describe, expect, it, vi } from 'vitest';
import { createCbmService, convertCbm, CbmError } from '../src/cbm.js';
import { buildServer } from '../src/server.js';
const now = new Date('2026-11-14T12:00:00Z');
const html = 'Foreign Exchange Rates as of 13<sup>th</sup> November 2026<table><th>Reference Rate</th><th>Market Trading Rate</th><tr><td>Korean Won</td><td>KRW</td><td>100/-=K</td><td>157.14</td><td>273.88</td></tr></table>';
const payload = { info: 'Central Bank of Myanmar', timestamp: '1794556800', rates: { KRW: '157.14' } };
const fetcher = () => vi.fn<typeof fetch>().mockImplementation(async url => new Response(String(url).endsWith('/api/latest') ? JSON.stringify(payload) : html, { headers: { 'content-type': String(url).endsWith('/api/latest') ? 'application/json' : 'text/html' } }));
describe('production CBM market conversion', () => {
  it.each([
    ['KRW','MMK','100000','273880.00',false],
    ['MMK','KRW','273880','100000',false],
    ['KRW','MMK','1.01','2.76',false],
    ['MMK','KRW','0.01','0',true],
    ['KRW','MMK','0','0.00',false],
    ['KRW','MMK','999999999999999.99','2738799999999999.97',false],
  ] as const)('converts %s to %s using the original per-100 market quote', async (from,to,amount,expected,small) => {
    const quote=await createCbmService({fetcher:fetcher(),now:()=>now}).quote();
    expect(quote).toMatchObject({provider:'cbm',rateType:'MARKET_TRADING',sourceTimeZone:'Asia/Yangon',mmkPer100Krw:'273.88',mmkPerKrw:'2.7388',referenceMmkPerKrw:'1.5714',publicationPrecision:'DATE',publishedAt:null,expiresAt:'2026-11-16T17:30:00.000Z',freshness:'PREVIOUS_PUBLISHED_RATE'});
    const result=convertCbm({from,to,amount},quote,now);
    expect(result.convertedAmount).toBe(expected); expect(result.belowDisplayPrecision).toBe(small);
    expect(result.calculationVersion).toBe('krw-mmk-cbm-market-1');
  });
  it('retains very small normalized rates without rounding them to zero',async()=>{
    const tiny=html.replace('273.88','0.000000000001');
    const upstream=vi.fn<typeof fetch>().mockImplementation(async url=>new Response(String(url).endsWith('/api/latest')?JSON.stringify(payload):tiny,{headers:{'content-type':String(url).endsWith('/api/latest')?'application/json':'text/html'}}));
    const quote=await createCbmService({fetcher:upstream,now:()=>now}).quote();
    expect(quote.mmkPerKrw).toBe('0.00000000000001'); expect(quote.rateDisplayDecimalPlaces).toBe(14);
    expect(convertCbm({from:'KRW',to:'MMK',amount:'1'},quote,now).belowDisplayPrecision).toBe(true);
  });
  it('rejects altered rates, invalid pairs, amounts and expired source dates',async()=>{
    const quote=await createCbmService({fetcher:fetcher(),now:()=>now}).quote();
    expect(()=>convertCbm({from:'KRW',to:'MMK',amount:'1'},{...quote,mmkPer100Krw:'157.14'},now)).toThrow('CBM_INVALID_RESPONSE');
    expect(()=>convertCbm({from:'KRW',to:'MMK',amount:'1'},{...quote,mmkPerKrw:'2.74'},now)).toThrow('CBM_INVALID_RESPONSE');
    expect(()=>convertCbm({from:'KRW',to:'KRW',amount:'1'},quote,now)).toThrow('UNSUPPORTED_CURRENCY_PAIR');
    expect(()=>convertCbm({from:'KRW',to:'MMK',amount:'1,000'},quote,now)).toThrow('INVALID_AMOUNT');
    expect(()=>convertCbm({from:'KRW',to:'MMK',amount:'1'},quote,new Date('2026-11-16T17:30:00Z'))).toThrow('CBM_STALE_PUBLICATION');
  });
  it('refreshes after the minimum interval, preserving quote identity and original retrieval on hits',async()=>{
    let clock=now; const upstream=fetcher(); const service=createCbmService({fetcher:upstream,now:()=>clock});
    const first=await service.quote(); clock=new Date(now.getTime()+30_000);
    const cached=await service.quote(true); expect(cached.retrievedAt).toBe(first.retrievedAt); expect(upstream).toHaveBeenCalledTimes(2);
    clock=new Date(now.getTime()+60_000);
    const refreshed=await service.quote(true); expect(upstream).toHaveBeenCalledTimes(4); expect(refreshed.quoteId).toBe(first.quoteId); expect(refreshed.retrievedAt).toBe(clock.toISOString());
  });
});
it('exposes dedicated CBM no-store HTTP endpoints, structured validation, and retains Hundi during CBM failure',async()=>{
  const upstream=fetcher(); const service=createCbmService({fetcher:upstream,now:()=>now});
  const app=await buildServer({cbm:service,now:()=>now});
  try {
    const quote=await app.inject('/v1/exchange-rates/krw-mmk/cbm');
    expect(quote.statusCode).toBe(200); expect(quote.headers['cache-control']).toBe('no-store');
    expect(quote.json()).toMatchObject({provider:'cbm',mmkPerKrw:'2.7388',referenceMmkPerKrw:'1.5714'});
    const conversion=await app.inject({method:'POST',url:'/v1/currency-conversions/cbm',payload:{from:'KRW',to:'MMK',amount:'100000'}});
    expect(conversion.statusCode).toBe(200); expect(conversion.json().convertedAmount).toBe('273880.00'); expect(conversion.headers['cache-control']).toBe('no-store'); expect(upstream).toHaveBeenCalledTimes(2);
    const bad=await app.inject({method:'POST',url:'/v1/currency-conversions/cbm',payload:{from:'KRW',to:'MMK',amount:1}});
    expect(bad.statusCode).toBe(400); expect(bad.json()).toMatchObject({code:'INVALID_AMOUNT',issues:[{field:'amount',code:'INVALID_AMOUNT'}]});
    expect((await app.inject({method:'POST',url:'/v1/currency-conversions/cbm',payload:{from:'KRW',to:'MMK',amount:'1',mmkPer100Krw:'999'}})).statusCode).toBe(400);
  } finally {await app.close();}
  const unavailable=await buildServer({cbm:{quote:async()=>{throw new CbmError('CBM_NETWORK_ERROR');}}});
  try {
    const failed=await unavailable.inject('/v1/exchange-rates/krw-mmk/cbm'); expect(failed.statusCode).toBe(503); expect(failed.json().code).toBe('RATE_UNAVAILABLE');
    const hundi=await unavailable.inject({method:'POST',url:'/v1/currency-conversions/hundi',payload:{from:'KRW',to:'MMK',amount:'100000',mmkPerUsd:'4400',usdPerKrw:'1350'}});
    expect(hundi.statusCode).toBe(200); expect(hundi.json()).toMatchObject({convertedAmount:'325925.92',calculationVersion:'krw-mmk-hundi-1'});
  } finally {await unavailable.close();}
});
it.each([['CBM_TIMEOUT','TIMEOUT',503],['CBM_STALE_PUBLICATION','RATE_EXPIRED',503],['CBM_RATE_LIMITED','RATE_LIMITED',429],['CBM_RETRY_LATER','RATE_LIMITED',429],['CBM_REFERENCE_MISMATCH','UPSTREAM_INVALID_RESPONSE',503]])('translates %s into the existing client error contract',async(code,expected,status)=>{
  const app=await buildServer({cbm:{quote:async()=>{throw new CbmError(String(code));}}});
  try { const response=await app.inject('/v1/exchange-rates/krw-mmk/cbm'); expect(response.statusCode).toBe(status); expect(response.json().code).toBe(expected); expect(response.headers['cache-control']).toBe('no-store'); }
  finally { await app.close(); }
});
