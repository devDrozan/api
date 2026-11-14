import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeQuote, convertCurrency, convertHundi, createRateService, configuredRateService, createFailoverService, parseKbQuote, parseKmbQuote, ExchangeError, type RawQuote } from '../src/exchange.js';
import { buildServer } from '../src/server.js';
const now = new Date('2026-11-08T03:00:00Z');
const raw = (values: Partial<RawQuote> = {}): RawQuote => ({ provider: 'kb', rateType: 'REFERENCE', publicationDate: '2026-11-08', krwPerQuotedUnit: '0.5', mmkUnit: '1', ...values });
const quote = () => normalizeQuote(raw(), now);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('reference conversion', () => {
  it.each([
    ['KRW','MMK','1000000','2000000.00'], ['MMK','KRW','2000000','1000000'], ['KRW','MMK','0','0.00'], ['MMK','KRW','0','0'],
    ['KRW','MMK','999999999999999.99','1999999999999999.98'],
  ] as const)('converts %s to %s exactly for %s', (from, to, amount, expected) => {
    const result = convertCurrency({ from, to, amount }, quote(), now);
    expect(result.convertedAmount).toBe(expected); expect(result.rounding).toBe('FLOOR_ONCE'); expect(result.calculationPrecision).toBe(80);
  });
  it('normalizes source units, reciprocal precision, and tiny positive output', () => {
    expect(convertCurrency({from:'KRW',to:'MMK',amount:'1000000'},normalizeQuote(raw({krwPerQuotedUnit:'50',mmkUnit:'100'}),now),now).convertedAmount).toBe('2000000.00');
    const third = normalizeQuote(raw({krwPerQuotedUnit:'0.3'}),now);
    expect(convertCurrency({from:'KRW',to:'MMK',amount:'1'},third,now).convertedAmount).toBe('3.33');
    const tiny = convertCurrency({from:'MMK',to:'KRW',amount:'1'},third,now);
    expect(tiny.convertedAmount).toBe('0'); expect(tiny.belowDisplayPrecision).toBe(true);
    expect(convertCurrency({from:'KRW',to:'MMK',amount:'3'},third,now).convertedAmount).toBe('10.00');
    const one = normalizeQuote(raw({krwPerQuotedUnit:'0.000000000000000001'}),now);
    expect(convertCurrency({from:'KRW',to:'MMK',amount:'1'},one,now).convertedAmount).toBe('1000000000000000000.00');
  });
  it.each(['-1','+1','1e6','1,000','01','1.001','1000000000000000','','NaN','Infinity'])('rejects invalid amount %s', amount => {
    expect(() => convertCurrency({from:'KRW',to:'MMK',amount},quote(),now)).toThrow('INVALID_AMOUNT');
  });
  it('rejects unsupported/same pairs and ignores no client quote overrides', () => {
    expect(() => convertCurrency({from:'KRW',to:'KRW',amount:'1'},quote(),now)).toThrow('UNSUPPORTED_CURRENCY_PAIR');
    expect(() => convertCurrency({from:'USD' as 'KRW',to:'MMK',amount:'1'},quote(),now)).toThrow('UNSUPPORTED_CURRENCY_PAIR');
    expect(() => convertCurrency({from:'KRW',to:'MMK',amount:'1'},{...quote(),krwPerQuotedUnit:'0.1'},now)).toThrow('UPSTREAM_INVALID_RESPONSE');
  });
});
describe('source and KST publication validation', () => {
  it.each([null, {}, {...raw(),rateType:'CASH'}, raw({provider:'other' as 'kb'}), raw({krwPerQuotedUnit:'0'}), raw({krwPerQuotedUnit:'-1'}), raw({krwPerQuotedUnit:'1e-3'}), raw({krwPerQuotedUnit:'0.0000000000000000001'}), raw({mmkUnit:'0'}), raw({mmkUnit:'1' as string, publicationDate:'2026-02-30'}), raw({publicationDate:'2026-11-09'}), raw({publishedAt:'2026-11-08T13:00:00+09:00'}), raw({publishedAt:'2026-11-07T00:00:00Z'}), raw({publishedAt:'not-a-time'})])('rejects malformed or future source %j', value => {
    expect(() => normalizeQuote(value,now)).toThrow('UPSTREAM_INVALID_RESPONSE');
  });
  it('keeps date-only precision, rejects provider mixing and never invents publication time', () => {
    expect(quote().publishedAt).toBeNull(); expect(quote().publicationPrecision).toBe('DATE');
    expect(quote().retrievedAt).toBe(now.toISOString()); expect(quote().sourceName).toBe('KB Kookmin Bank');
    const full = normalizeQuote(raw({publishedAt:'2026-11-08T09:00:00+09:00'}),now);
    expect(full.publicationPrecision).toBe('SECOND');
    expect(() => normalizeQuote(raw({provider:'kmb'}),now,'kb')).toThrow('UPSTREAM_INVALID_RESPONSE');
  });
  it('allows a previous publication through day three and expires at Korean midnight on day four', () => {
    const previous = normalizeQuote(raw({publicationDate:'2026-11-05'}),now);
    expect(previous.freshness).toBe('PREVIOUS_PUBLISHED_RATE'); expect(previous.expiresAt).toBe('2026-11-08T15:00:00.000Z');
    expect(() => normalizeQuote(raw({publicationDate:'2026-11-04'}),now)).toThrow('RATE_EXPIRED');
    expect(() => convertCurrency({from:'KRW',to:'MMK',amount:'1'},previous,new Date('2026-11-08T15:00:00Z'))).toThrow('RATE_EXPIRED');
    expect(normalizeQuote(raw(),new Date('2026-11-07T15:00:00Z')).freshness).toBe('PUBLISHED_TODAY');
  });
});
describe('Korean official sources and failover', () => {
  const kbPage = (stamp = '2026.11.06&nbsp;06:24:38', rate = '0.64') => `<table class="tType01"><tbody><tr><td>${stamp} (553회차)</td><td>2026-11-08 10:00:00</td></tr></tbody></table>
<table class="tType01"><tbody><tr><td><a onclick="javascript:uf_goLink('MMK'); return false;">MMK</a></td><td class="tLeft"><a onclick="javascript:uf_goLink('MMK'); return false;">미얀마(짯)</a></td><td class="tRight">${rate}</td><td class="tRight">0.65</td><td class="tRight">0.63</td><td class="tRight">0.66</td><td class="tRight">0.62</td><td class="tRight">0.0005</td><td id="goLinkVal">변동추이</td></tr></tbody></table>`;
  const kmbPage = (date = '2026-11-08', rate = '0.63') => `<dl><dt>기준일자</dt><dd>${date}</dd></dl><table><tbody><tr><td>미국 달러(USD)</td><td>1</td><td>1332.4</td></tr><tr><td>미얀마 짯(MMK)</td><td>2100</td><td>${rate}</td></tr></tbody></table>`;
  it('parses the KB official table with its publication stamp and converts at the published base rate', () => {
    const parsed = parseKbQuote(kbPage());
    expect(parsed).toEqual({ provider: 'kb', rateType: 'REFERENCE', publicationDate: '2026-11-06', publishedAt: '2026-11-06T06:24:38+09:00', krwPerQuotedUnit: '0.64', mmkUnit: '1' });
    const checked = normalizeQuote(parsed, now);
    expect(checked.sourceName).toBe('KB Kookmin Bank'); expect(checked.publicationPrecision).toBe('SECOND'); expect(checked.freshness).toBe('PREVIOUS_PUBLISHED_RATE');
    expect(checked.krwPerMmk).toBe('0.64'); expect(checked.mmkPerKrw).toBe('1.5625');
    expect(convertCurrency({ from: 'KRW', to: 'MMK', amount: '100000' }, checked, now).convertedAmount).toBe('156250.00');
  });
  it.each([
    ['missing stamp', kbPage().replace('(553회차)', '(회차)')],
    ['missing kyat row', kbPage().replaceAll('MMK', 'USD').replaceAll('미얀마(짯)', '미국(달러)')],
    ['zero rate', kbPage('2026.11.06&nbsp;06:24:38', '0')],
    ['implausible rate', kbPage('2026.11.06&nbsp;06:24:38', '640')],
    ['impossible date', kbPage('2026.02.30&nbsp;06:24:38')],
    ['empty document', ''],
  ])('rejects a malformed KB page (%s) instead of inventing a rate', (_label, html) => {
    expect(() => parseKbQuote(html)).toThrow('UPSTREAM_INVALID_RESPONSE');
  });
  it('parses the KMB interbank table without inventing a publication time', () => {
    const parsed = parseKmbQuote(kmbPage());
    expect(parsed).toEqual({ provider: 'kmb', rateType: 'REFERENCE', publicationDate: '2026-11-08', krwPerQuotedUnit: '0.63', mmkUnit: '1' });
    const checked = normalizeQuote(parsed, now);
    expect(checked.publishedAt).toBeNull(); expect(checked.sourceName).toBe('Korea Money Brokerage Corp.');
    expect(() => parseKmbQuote(kmbPage('2026-11-08', '0'))).toThrow('UPSTREAM_INVALID_RESPONSE');
    expect(() => parseKmbQuote('<dl><dt>기준일자</dt><dd>2026-11-08</dd></dl><table></table>')).toThrow('UPSTREAM_INVALID_RESPONSE');
  });
  it('serves KB first and falls back to KMB without claiming the wrong provider', async () => {
    const kb = vi.fn().mockRejectedValue(new Error('network'));
    const kmb = vi.fn().mockResolvedValue(parseKmbQuote(kmbPage()));
    const service = configuredRateService({ EXCHANGE_RATE_PROVIDER: 'auto' }, { kb, kmb, now: () => now });
    const first = await service.quote();
    expect(first.provider).toBe('kmb'); expect(first.sourceName).toBe('Korea Money Brokerage Corp.');
    await service.quote(); expect(kb).toHaveBeenCalledTimes(1); // throttled primary, cached fallback
  });
  it('falls back when KB publishes a stale or invalid table', async () => {
    for (const kb of [vi.fn().mockResolvedValue(parseKbQuote(kbPage('2026.10.31&nbsp;06:24:38'))), vi.fn().mockRejectedValue(new ExchangeError('UPSTREAM_INVALID_RESPONSE'))]) {
      const service = configuredRateService({}, { kb, kmb: vi.fn().mockResolvedValue(parseKmbQuote(kmbPage())), now: () => now });
      expect((await service.quote()).provider).toBe('kmb');
    }
  });
  it('reports unavailable only after every source fails, and expired only when all are stale', async () => {
    const down = () => vi.fn().mockRejectedValue(new Error('network'));
    await expect(configuredRateService({}, { kb: down(), kmb: down(), now: () => now }).quote()).rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' });
    const stale = () => vi.fn().mockRejectedValue(new ExchangeError('RATE_EXPIRED'));
    await expect(configuredRateService({}, { kb: stale(), kmb: stale(), now: () => now }).quote()).rejects.toMatchObject({ code: 'RATE_EXPIRED' });
    const ordered = createFailoverService([{ quote: async () => { throw new ExchangeError('RATE_EXPIRED'); } }, { quote: async () => quote() }]);
    expect((await ordered.quote()).provider).toBe('kb');
  });
  it('disables official conversion without making any request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const env of [{ EXCHANGE_RATE_PROVIDER: 'none' }, { EXCHANGE_RATE_PROVIDER: 'other' }, { EXCHANGE_RATE_PROVIDER: 'hana' }]) await expect(configuredRateService(env).quote()).rejects.toThrow('RATE_UNAVAILABLE');
    await expect(configuredRateService({ EXCHANGE_RATE_PROVIDER: 'kb' }, { kb: vi.fn().mockRejectedValue(new Error('network')), now: () => now }).quote()).rejects.toThrow('RATE_UNAVAILABLE');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fetches the KB page with a bounded body and a browser identity', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(kbPage(), { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    vi.stubGlobal('fetch', fetcher);
    const parsed = await configuredRateService({}, { now: () => now, kmb: vi.fn().mockRejectedValue(new Error('unused')) }).quote();
    expect(parsed.provider).toBe('kb');
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://obank.kbstar.com/quics?page=C101423');
    expect(options.redirect).toBe('error'); expect(options.headers['User-Agent']).toContain('Mozilla/5.0');
    fetcher.mockResolvedValue(new Response('x'.repeat(524_289), { headers: { 'content-type': 'text/html' } }));
    await expect(configuredRateService({ EXCHANGE_RATE_PROVIDER: 'kb' }, { now: () => now }).quote()).rejects.toThrow('UPSTREAM_INVALID_RESPONSE');
  });
  it('uses an approved licensed feed (for example Hana) only when configured', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw({ provider: 'hana' })), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const service = configuredRateService({ EXCHANGE_RATE_PROVIDER: 'hana', EXCHANGE_RATE_ACCESS_APPROVED: 'true', EXCHANGE_RATE_FEED_URL: 'https://approved.example/rates', EXCHANGE_RATE_FEED_TOKEN: 'test-only-secret' }, { now: () => now });
    expect((await service.quote()).provider).toBe('hana');
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://approved.example/rates'); expect(options.body).toBeUndefined(); expect(options.redirect).toBe('error'); expect(options.headers.Authorization).toBe('Bearer test-only-secret');
    fetcher.mockResolvedValue(new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }));
    await expect(configuredRateService({ EXCHANGE_RATE_PROVIDER: 'hana', EXCHANGE_RATE_ACCESS_APPROVED: 'true', EXCHANGE_RATE_FEED_URL: 'https://approved.example/rates' }, { now: () => now }).quote()).rejects.toThrow('UPSTREAM_INVALID_RESPONSE');
    for (const env of [{ EXCHANGE_RATE_PROVIDER: 'hana', EXCHANGE_RATE_ACCESS_APPROVED: 'false', EXCHANGE_RATE_FEED_URL: 'https://approved.example/rates' }, { EXCHANGE_RATE_PROVIDER: 'hana', EXCHANGE_RATE_ACCESS_APPROVED: 'true', EXCHANGE_RATE_FEED_URL: 'http://approved.example/rates' }]) await expect(configuredRateService(env).quote()).rejects.toThrow('RATE_UNAVAILABLE');
  });
  it('never resets timestamps on failure, and refuses cache after TTL or publication expiry', async () => {
    let current = new Date(now); const loader = vi.fn().mockResolvedValueOnce(raw()).mockRejectedValue(new Error('network'));
    const service = createRateService(loader,'kb',()=>current); const first = await service.quote();
    current = new Date(now.getTime()+60_000); expect((await service.quote(true)).retrievedAt).toBe(first.retrievedAt);
    current = new Date(now.getTime()+900_000); await expect(service.quote()).rejects.toThrow('RATE_UNAVAILABLE');
    await expect(service.quote(true)).rejects.toThrow('RATE_LIMITED');
    current = new Date('2026-11-12T00:00:00Z'); await expect(service.quote()).rejects.toThrow('RATE_UNAVAILABLE');
  });
  it('shares concurrent retrieval and throttles manual refresh', async () => {
    let current = new Date(now); let finish!: (value: unknown) => void;
    const loader = vi.fn(() => new Promise(resolve => { finish = resolve; })); const service = createRateService(loader,'kb',()=>current);
    const first = service.quote(), second = service.quote(); expect(loader).toHaveBeenCalledTimes(1); finish(raw());
    const result = await first; expect(await second).toEqual(result); expect(await service.quote(true)).toEqual(result);
    current = new Date(now.getTime()+60_000); const refreshed = service.quote(true); expect(loader).toHaveBeenCalledTimes(2); finish(raw());
    const newer = await refreshed; expect(newer.retrievedAt).not.toBe(result.retrievedAt); expect(newer.quoteId).toBe(result.quoteId);
  });
  it('does not reuse a different/invalid provider quote', async () => {
    const service = createRateService(async()=>raw({provider:'kmb'}),'kb',()=>now);
    await expect(service.quote()).rejects.toThrow('UPSTREAM_INVALID_RESPONSE');
  });
});
describe('user-rate hundi conversion', () => {
  const hundi = (values: Partial<Parameters<typeof convertHundi>[0]> = {}) => ({ from: 'KRW' as const, to: 'MMK' as const, amount: '100000', mmkPerUsd: '4400', usdPerKrw: '1350', ...values });
  it('applies KRW × MMK/USD ÷ USD/KRW and the exact inverse without a rounded display rate', () => {
    const krwToMmk = convertHundi(hundi());
    expect(krwToMmk.convertedAmount).toBe('325925.92');
    expect(krwToMmk.rates).toEqual({ mmkPerUsd: '4400', usdPerKrw: '1350', mmkPerKrw: '3.259259259259' });
    expect(krwToMmk.calculationVersion).toBe('krw-mmk-hundi-1'); expect(krwToMmk.rounding).toBe('FLOOR_ONCE'); expect(krwToMmk.decimalPlaces).toBe(2);
    const mmkToKrw = convertHundi(hundi({ from: 'MMK', to: 'KRW', amount: '4400000' }));
    expect(mmkToKrw.convertedAmount).toBe('1350000'); expect(mmkToKrw.decimalPlaces).toBe(0);
    const doubled = convertHundi(hundi({ mmkPerUsd: '8800' }));
    expect(doubled.convertedAmount).toBe('651851.85');
  });
  it('keeps decimal rates exact, flags below-precision output, and handles zero', () => {
    expect(convertHundi(hundi({ amount: '1', mmkPerUsd: '1', usdPerKrw: '1' })).convertedAmount).toBe('1.00');
    expect(convertHundi(hundi({ amount: '0.5', mmkPerUsd: '4400.5', usdPerKrw: '1350.25' })).convertedAmount).toBe('1.62');
    const tiny = convertHundi(hundi({ from: 'MMK', to: 'KRW', amount: '0.01' }));
    expect(tiny.convertedAmount).toBe('0'); expect(tiny.belowDisplayPrecision).toBe(true);
    expect(convertHundi(hundi({ amount: '0' })).convertedAmount).toBe('0.00');
    expect(convertHundi(hundi({ amount: '999999999999999.99', mmkPerUsd: '999999', usdPerKrw: '0.0001' })).convertedAmount).not.toContain('e');
  });
  it.each(['0', '', '-1', '1e3', '1,000', '01', '1.23456', '1000000', '4400.'])('rejects invalid hundi rate %s', mmkPerUsd => {
    expect(() => convertHundi(hundi({ mmkPerUsd }))).toThrow('INVALID_HUNDI_RATE');
    expect(() => convertHundi(hundi({ usdPerKrw: mmkPerUsd }))).toThrow('INVALID_USD_KRW_RATE');
  });
  it('rejects invalid amounts and unsupported pairs before converting', () => {
    for (const amount of ['-1', '1e6', '1,000', '01', '1.001', '']) expect(() => convertHundi(hundi({ amount }))).toThrow('INVALID_AMOUNT');
    expect(() => convertHundi(hundi({ to: 'KRW' } as never))).toThrow('UNSUPPORTED_CURRENCY_PAIR');
    expect(() => convertHundi(hundi({ from: 'USD' } as never))).toThrow('UNSUPPORTED_CURRENCY_PAIR');
  });
});
it('exposes backward-compatible no-store HTTP contracts and structured currency errors', async () => {
  const app = await buildServer({exchange:{quote:async()=>quote()},now:()=>now});
  try {
    const rate = await app.inject('/v1/exchange-rates/krw-mmk?refresh=true'); expect(rate.statusCode).toBe(200); expect(rate.headers['cache-control']).toBe('no-store');
    const result = await app.inject({method:'POST',url:'/v1/currency-conversions',payload:{from:'KRW',to:'MMK',amount:'1000000'}});
    expect(result.statusCode).toBe(200); expect(result.json().convertedAmount).toBe('2000000.00'); expect(result.headers['cache-control']).toBe('no-store');
    for (const payload of [{from:'KRW',to:'KRW',amount:'1'}, {from:'USD',to:'MMK',amount:'1'}, {from:'KRW',to:'MMK',amount:'-1'}, {from:'KRW',to:'MMK',amount:1}]) {
      const invalid = await app.inject({method:'POST',url:'/v1/currency-conversions',payload}); expect(invalid.statusCode).toBe(400); expect(invalid.json().issues).toHaveLength(1);
    }
    expect((await app.inject({method:'POST',url:'/v1/currency-conversions',payload:{from:'KRW',to:'MMK',amount:'1',rate:'9'}})).statusCode).toBe(400);
    const hundi = await app.inject({method:'POST',url:'/v1/currency-conversions/hundi',payload:{from:'KRW',to:'MMK',amount:'100000',mmkPerUsd:'4400',usdPerKrw:'1350'}});
    expect(hundi.statusCode).toBe(200); expect(hundi.json().convertedAmount).toBe('325925.92'); expect(hundi.headers['cache-control']).toBe('no-store');
    const badRate = await app.inject({method:'POST',url:'/v1/currency-conversions/hundi',payload:{from:'KRW',to:'MMK',amount:'1',mmkPerUsd:'0',usdPerKrw:'1350'}});
    expect(badRate.statusCode).toBe(400); expect(badRate.json()).toMatchObject({code:'INVALID_HUNDI_RATE',issues:[{field:'mmkPerUsd',code:'INVALID_HUNDI_RATE'}]});
    const badUsd = await app.inject({method:'POST',url:'/v1/currency-conversions/hundi',payload:{from:'KRW',to:'MMK',amount:'1',mmkPerUsd:'4400',usdPerKrw:'0'}});
    expect(badUsd.statusCode).toBe(400); expect(badUsd.json()).toMatchObject({code:'INVALID_USD_KRW_RATE',issues:[{field:'usdPerKrw',code:'INVALID_USD_KRW_RATE'}]});
    expect((await app.inject({method:'POST',url:'/v1/currency-conversions/hundi',payload:{from:'KRW',to:'MMK',amount:'1',mmkPerUsd:'4400'}})).statusCode).toBe(400);
    expect((await app.inject('/health')).statusCode).toBe(200);
  } finally { await app.close(); }
});
it('returns explicit unavailable when official conversion is disabled instead of a synthetic rate', async () => {
  const app = await buildServer({exchange:configuredRateService({EXCHANGE_RATE_PROVIDER:'none'})});
  try { const result = await app.inject('/v1/exchange-rates/krw-mmk'); expect(result.statusCode).toBe(503); expect(result.json().code).toBe('RATE_UNAVAILABLE'); }
  finally { await app.close(); }
});
