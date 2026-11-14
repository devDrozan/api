import { afterEach, describe, expect, it, vi } from 'vitest';
import { CBM_REFERENCE_API, CBM_WEBSITE, createCbmProbe, parseReferenceApi, parseWebsite } from './cbm-rates.js';
// Minimal fixture of CBM's observed 13 Nov 2026 table shape; not a hardcoded live rate.
const now = new Date('2026-11-14T12:00:00Z');
const header = '<th>Reference Rate</th><th>Market Trading Rate</th>';
const row = '<tr><td>Korean Won</td><td>KRW</td><td>100/-=K</td><td>157.14</td><td>273.88</td></tr>';
const page = `Foreign Exchange Rates as of 13<sup>th</sup> November 2026<table>${header}${row}</table>`;
const payload = { info: 'Central Bank of Myanmar', timestamp: '1794556800', rates: { KRW: '157.14' } };
const jsonResponse = (body = JSON.stringify(payload)) => new Response(body, { headers: { 'content-type': 'application/json' } });
const htmlResponse = (body = page) => new Response(body, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
const fixtureFetch = () => vi.fn<typeof fetch>().mockImplementation(async url => String(url) === CBM_WEBSITE ? htmlResponse() : jsonResponse());
afterEach(() => vi.useRealTimers());
describe('CBM quote parsing and comparison', () => {
  it('divides the market and reference quotations by 100 exactly, without mixing columns', () => {
    const html = parseWebsite(page, now), api = parseReferenceApi(payload, now);
    expect(html.marketMmkPerKrw).toBe('2.7388');
    expect(html.referenceMmkPerKrw).toBe('1.5714');
    expect(api.referenceMmkPerKrw).toBe('1.5714');
    expect(api.publicationDate).toBe('2026-11-13');
    expect(api.sourceTimestamp).toBe(payload.timestamp);
    expect(parseWebsite(page.replace('273.88','1,273.880001'),now).marketMmkPerKrw).toBe('12.73880001');
  });
  it.each([
    page.replace(row,''), page.replace(row,row+row), page.replace('100/-=K','1/-=K'),
    page.replace(header,'<th>Market Trading Rate</th><th>Reference Rate</th>'),
    page.replace('273.88','0'), page.replace('273.88','NaN'), page.replace('273.88','1,27.3'),
    page.replace('13<sup>th</sup> November','31<sup>st</sup> November'),
    page.replace('13<sup>th</sup> November','13<sup>th</sup> Nope'), '<html>Access denied</html>',
  ])('rejects missing/changed/ambiguous website data', html => expect(() => parseWebsite(html,now)).toThrow('CBM_INVALID_RESPONSE'));
  it.each([null, {}, {...payload, info:'Other bank'}, {...payload, timestamp:'invalid'}, {...payload,rates:{}}, {...payload,rates:{KRW:'0'}}, {...payload,rates:{KRW:157.14}}])('rejects malformed reference API data', value => expect(() => parseReferenceApi(value,now)).toThrow('CBM_INVALID_RESPONSE'));
  it('checks Myanmar publication age, future dates and leap dates', () => {
    expect(() => parseWebsite(page,new Date('2026-11-12T12:00:00Z'))).toThrow('CBM_FUTURE_PUBLICATION');
    expect(() => parseWebsite(page,new Date('2026-11-16T17:29:59Z'))).not.toThrow();
    expect(() => parseWebsite(page,new Date('2026-11-16T17:30:00Z'))).toThrow('CBM_STALE_PUBLICATION');
    expect(() => parseWebsite(page.replace('13<sup>th</sup> November 2026','29<sup>th</sup> February 2024'),new Date('2024-02-29T12:00:00Z'))).not.toThrow();
  });
});
describe('experimental backend retrieval/cache', () => {
  it('fetches official HTTPS sources only once, shares concurrent calls, preserves metadata and isolates mutations', async () => {
    const fetcher = fixtureFetch(); const probe = createCbmProbe({fetcher,now:()=>now});
    const [first,shared] = await Promise.all([probe.get(),probe.get()]);
    expect(first.cache).toBe('MISS'); expect(shared.cache).toBe('SHARED'); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.comparison).toEqual({samePublicationDate:true,referenceMatchesWebsite:true,marketNormalizationMatchesWebsite:true});
    first.website.marketMmkPerKrw = '9';
    const hit = await probe.get(); expect(hit.cache).toBe('HIT'); expect(hit.website.marketMmkPerKrw).toBe('2.7388'); expect(hit.retrievedAt).toBe(shared.retrievedAt);
    expect(fetcher.mock.calls.map(call=>call[0])).toEqual([CBM_WEBSITE,CBM_REFERENCE_API]);
    expect(fetcher.mock.calls.every(call=>call[1]?.redirect==='error' && call[1]?.cache==='no-store' && !call[1]?.body)).toBe(true);
  });
  it('expires the cache and fails closed on refresh failure, without relabeling old data as fresh', async () => {
    let time = now; const fetcher = fixtureFetch(); const probe = createCbmProbe({fetcher,now:()=>time});
    await probe.get(); time = new Date(now.getTime()+900_000);
    fetcher.mockRejectedValue(new Error('offline'));
    await expect(probe.get()).rejects.toThrow('CBM_NETWORK_ERROR');
    await expect(probe.get()).rejects.toThrow('CBM_RETRY_LATER'); expect(fetcher).toHaveBeenCalledTimes(4);
    time = new Date(time.getTime()+60_000); fetcher.mockImplementation(async url=>String(url)===CBM_WEBSITE?htmlResponse():jsonResponse());
    expect((await probe.get()).retrievedAt).toBe(time.toISOString());
  });
  it.each([
    [JSON.stringify({...payload,rates:{KRW:'200'}}),'CBM_REFERENCE_MISMATCH'],
    [JSON.stringify({...payload,timestamp:'1794470400'}),'CBM_PUBLICATION_MISMATCH'],
    ['{bad json','CBM_INVALID_RESPONSE'],
  ])('does not cache comparison/JSON errors', async (body, code) => {
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async url=>String(url)===CBM_WEBSITE?htmlResponse():jsonResponse(body));
    const probe=createCbmProbe({fetcher,now:()=>now});
    await expect(probe.get()).rejects.toThrow(code); await expect(probe.get()).rejects.toThrow('CBM_RETRY_LATER'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([403,429,503])('returns explicit upstream HTTP %s errors and respects numeric Retry-After', async status => {
    let time=now;
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status,headers:{'retry-after':'120'}}));
    const probe=createCbmProbe({fetcher,now:()=>time});
    await expect(probe.get()).rejects.toMatchObject({code:status===429?'CBM_RATE_LIMITED':'CBM_HTTP_ERROR',upstreamStatus:status});
    time=new Date(now.getTime()+61_000); await expect(probe.get()).rejects.toThrow('CBM_RETRY_LATER'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    ()=>new Response('{}',{headers:{'content-type':'text/plain'}}),
    ()=>jsonResponse('x'.repeat(65_537)),
    ()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'65537'}}),
  ])('rejects unexpected content or oversized bodies', async response => {
    const probe=createCbmProbe({fetcher:vi.fn<typeof fetch>().mockImplementation(async url=>String(url)===CBM_WEBSITE?htmlResponse():response()),now:()=>now});
    await expect(probe.get()).rejects.toThrow('CBM_INVALID_RESPONSE');
  });
  it('bounds a stalled response body as well as connecting', async () => {
    const probe=createCbmProbe({fetcher:vi.fn<typeof fetch>().mockImplementation(async ()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/html'}})),now:()=>now,timeoutMs:20});
    await expect(probe.get()).rejects.toThrow('CBM_TIMEOUT');
  });
  it('rechecks publication expiry on a cache hit across Myanmar midnight', async () => {
    let time=new Date('2026-11-16T17:29:00Z');
    const probe=createCbmProbe({fetcher:fixtureFetch(),now:()=>time}); await probe.get();
    time=new Date('2026-11-16T17:30:00Z'); await expect(probe.get()).rejects.toThrow('CBM_STALE_PUBLICATION');
  });
});
