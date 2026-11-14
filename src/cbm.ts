import { Decimal } from 'decimal.js';
import { Type, type Static } from '@sinclair/typebox';
import { createHash } from 'node:crypto';
import { ConversionResponse, validatePairAmount, type ConversionRequest } from './exchange.js';
const D = Decimal.clone({ precision: 80 });
export const CBM_WEBSITE = 'https://forex.cbm.gov.mm/index.php/fxrate';
export const CBM_REFERENCE_API = 'https://forex.cbm.gov.mm/api/latest';
export class CbmError extends Error {
  constructor(public code: string, public upstreamStatus?: number, public retryAfterMs = 60_000) { super(code); }
}
const invalid = (): never => { throw new CbmError('CBM_INVALID_RESPONSE'); };
const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const myanmarDay = (date: Date) => new Date(date.getTime() + 390 * 60_000).toISOString().slice(0, 10);
function checkDate(date: string, now: Date) {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) invalid();
  const age = (Date.parse(`${myanmarDay(now)}T00:00:00Z`) - parsed) / 86_400_000;
  if (age < 0) throw new CbmError('CBM_FUTURE_PUBLICATION');
  if (age > 3) throw new CbmError('CBM_STALE_PUBLICATION');
}
function rate(text: unknown): string {
  if (typeof text !== 'string' || !/^(?:0|[1-9]\d{0,14}|[1-9]\d{0,2}(?:,\d{3}){1,4})(?:\.\d{1,12})?$/.test(text)) invalid();
  const value = (text as string).replaceAll(',', '');
  if (new D(value).lte(0)) invalid();
  return value;
}
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;|&#x[aA]0;/g, ' ').replace(/\s+/g, ' ').trim();
export function parseWebsite(html: string, now: Date) {
  // Fail closed if CBM changes the column order or quotation unit; never select another currency.
  const clean = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  if (!/<th\b[^>]*>\s*Reference Rate\s*<\/th>\s*<th\b[^>]*>\s*Market Trading Rate\s*<\/th>/i.test(clean)) invalid();
  const dates = [...text(clean).matchAll(/Foreign Exchange Rates as of\s+(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(20\d{2})/g)];
  if (dates.length !== 1) invalid();
  const [, day, month, year] = dates[0]!;
  const monthIndex = months.indexOf(month!);
  if (monthIndex < 0) invalid();
  const publicationDate = `${year}-${String(monthIndex + 1).padStart(2,'0')}-${day!.padStart(2,'0')}`;
  checkDate(publicationDate, now);
  const rows = [...clean.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(row => [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => text(cell[1]!)))
    .filter(cells => cells[1] === 'KRW');
  if (rows.length !== 1 || rows[0]!.length !== 5 || rows[0]![2]!.replaceAll(' ','') !== '100/-=K') invalid();
  const referencePer100Krw = rate(rows[0]![3]), marketPer100Krw = rate(rows[0]![4]);
  return {
    sourceUrl: CBM_WEBSITE, publicationDate, quotedKrw: '100',
    referencePer100Krw, referenceMmkPerKrw: new D(referencePer100Krw).div(100).toFixed(),
    marketPer100Krw, marketMmkPerKrw: new D(marketPer100Krw).div(100).toFixed(),
    marketClassification: 'CBM_PUBLISHED_INDICATIVE_CROSS_RATE_BASED_ON_MARKET_TRADING_RATE' as const,
  };
}
export function parseReferenceApi(value: unknown, now: Date) {
  if (!value || typeof value !== 'object') invalid();
  const row = value as { info?: unknown; timestamp?: unknown; rates?: Record<string, unknown> };
  if (row.info !== 'Central Bank of Myanmar' || !row.rates || typeof row.rates !== 'object' || !/^[1-9]\d{9}$/.test(String(row.timestamp))) invalid();
  const timestamp = Number(row.timestamp) * 1000;
  if (timestamp > now.getTime()) throw new CbmError('CBM_FUTURE_PUBLICATION');
  const publicationDate = myanmarDay(new Date(timestamp));
  checkDate(publicationDate, now);
  const referencePer100Krw = rate(row.rates!.KRW);
  // API omits quotation units. Use KRW's 100-unit basis only alongside the verified website row.
  return { sourceUrl: CBM_REFERENCE_API, sourceTimestamp: String(row.timestamp), publicationDate,
    timestampMeaning: 'SOURCE_DATE_METADATA_NOT_VERIFIED_PUBLICATION_INSTANT' as const,
    quotedKrw: '100', referencePer100Krw, referenceMmkPerKrw: new D(referencePer100Krw).div(100).toFixed() };
}
type Snapshot = { retrievedAt: string; expiresAt: string; website: ReturnType<typeof parseWebsite>; referenceApi: ReturnType<typeof parseReferenceApi>; comparison: { samePublicationDate: true; referenceMatchesWebsite: true; marketNormalizationMatchesWebsite: true } };
export function createCbmProbe(options: { fetcher?: typeof fetch; now?: () => Date; ttlMs?: number; timeoutMs?: number } = {}) {
  const fetcher = options.fetcher ?? fetch, now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 900_000, timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 900_000 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15_000) throw new Error('INVALID_PROBE_OPTIONS');
  let cached: Snapshot | undefined, pending: Promise<Snapshot> | undefined, retryAt = 0;
  async function read(url: string, kind: 'html' | 'json') {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = async () => {
      const response = await fetcher(url, { signal: controller.signal, redirect: 'error', cache: 'no-store', headers: { Accept: kind === 'html' ? 'text/html' : 'application/json', 'User-Agent': 'E9MateMyanmar/0.1' } });
      if (!response.ok) {
        await response.body?.cancel();
        const seconds = response.headers.get('retry-after');
        const delay = seconds && /^\d+$/.test(seconds) ? Math.min(3600, Math.max(60, Number(seconds))) * 1000 : 60_000;
        throw new CbmError(response.status === 429 ? 'CBM_RATE_LIMITED' : 'CBM_HTTP_ERROR', response.status, delay);
      }
      const limit = kind === 'html' ? 262_144 : 65_536;
      if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== (kind === 'html' ? 'text/html' : 'application/json') || Number(response.headers.get('content-length') ?? 0) > limit || !response.body) { await response.body?.cancel(); invalid(); }
      const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > limit) { await reader.cancel(); invalid(); } chunks.push(chunk.value); }
        if (controller.signal.aborted) throw new CbmError('CBM_TIMEOUT');
        return Buffer.concat(chunks).toString('utf8');
      } finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    };
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CbmError('CBM_TIMEOUT')); }, timeoutMs); })]);
    } catch (error) { if (error instanceof CbmError) throw error; throw new CbmError(controller.signal.aborted ? 'CBM_TIMEOUT' : 'CBM_NETWORK_ERROR'); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async function load(): Promise<Snapshot> {
    // Wait for both bounded operations even on failure; no background retry or request logging.
    const responses = await Promise.allSettled([read(CBM_WEBSITE, 'html'), read(CBM_REFERENCE_API, 'json')]);
    const failed = responses.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const html = (responses[0] as PromiseFulfilledResult<string>).value;
    const json = (responses[1] as PromiseFulfilledResult<string>).value;
    const retrieved = now(); const website = parseWebsite(html, retrieved);
    let value: unknown; try { value = JSON.parse(json); } catch { invalid(); }
    const referenceApi = parseReferenceApi(value, retrieved);
    if (website.publicationDate !== referenceApi.publicationDate) throw new CbmError('CBM_PUBLICATION_MISMATCH');
    if (!new D(website.referencePer100Krw).eq(referenceApi.referencePer100Krw)) throw new CbmError('CBM_REFERENCE_MISMATCH');
    return { retrievedAt: retrieved.toISOString(), expiresAt: new Date(retrieved.getTime() + ttlMs).toISOString(), website, referenceApi,
      comparison: { samePublicationDate: true, referenceMatchesWebsite: true, marketNormalizationMatchesWebsite: new D(website.marketMmkPerKrw).mul(100).eq(website.marketPer100Krw) as true } };
  }
  return {
    async get(refresh = false) {
      const current = now();
      if (cached && current.getTime() < Date.parse(cached.expiresAt) && (!refresh || current.getTime() < retryAt)) {
        checkDate(cached.website.publicationDate, current);
        return { cache: 'HIT' as const, ...structuredClone(cached) };
      }
      if (pending) return { cache: 'SHARED' as const, ...structuredClone(await pending) };
      if (current.getTime() < retryAt) throw new CbmError('CBM_RETRY_LATER', undefined, retryAt - current.getTime());
      retryAt = current.getTime() + 60_000;
      const operation = load(); pending = operation;
      try { cached = await operation; return { cache: 'MISS' as const, ...structuredClone(cached) }; }
      catch (error) { if (error instanceof CbmError) retryAt = Math.max(retryAt, now().getTime() + error.retryAfterMs); throw error; }
      finally { if (pending === operation) pending = undefined; }
    },
  };
}

export const CbmQuoteSchema = Type.Object({
  quoteId: Type.String(), provider: Type.Literal('cbm'), sourceName: Type.String(), sourceUrl: Type.String(),
  rateType: Type.Literal('MARKET_TRADING'), sourceTimeZone: Type.Literal('Asia/Yangon'),
  publicationDate: Type.String(), publishedAt: Type.Null(), publicationPrecision: Type.Literal('DATE'),
  retrievedAt: Type.String(), expiresAt: Type.String(),
  freshness: Type.Union([Type.Literal('PUBLISHED_TODAY'), Type.Literal('PREVIOUS_PUBLISHED_RATE')]),
  quotedKrw: Type.Literal('100'), mmkPer100Krw: Type.String(), mmkPerKrw: Type.String(),
  referenceMmkPer100Krw: Type.String(), referenceMmkPerKrw: Type.String(), referenceSourceUrl: Type.String(),
  krwPerQuotedUnit: Type.Literal('100'), mmkUnit: Type.String(), krwPerMmk: Type.String(), rateDisplayDecimalPlaces: Type.Literal(14),
});
export type CbmQuote = Static<typeof CbmQuoteSchema>;
export const CbmConversionSchema = Type.Object({ ...ConversionResponse.properties, quote: CbmQuoteSchema, calculationVersion: Type.Literal('krw-mmk-cbm-market-1') });
export type CbmConversion = Static<typeof CbmConversionSchema>;
function quoteId(date: string, market: string, reference: string) {
  return createHash('sha256').update(JSON.stringify(['cbm','MARKET_TRADING',date,market,reference])).digest('hex');
}
export function createCbmService(options: Parameters<typeof createCbmProbe>[0] = {}) {
  const probe = createCbmProbe(options);
  const clock = options.now ?? (() => new Date());
  return {
    async quote(refresh = false): Promise<CbmQuote> {
      const snapshot = await probe.get(refresh);
      const source = snapshot.website;
      const current = clock();
      checkDate(source.publicationDate, current);
      const expiresAt = new Date(Date.parse(`${source.publicationDate}T00:00:00+06:30`) + 4 * 86_400_000).toISOString();
      return {
        quoteId: quoteId(source.publicationDate, source.marketPer100Krw, source.referencePer100Krw),
        provider: 'cbm', sourceName: 'Central Bank of Myanmar', sourceUrl: CBM_WEBSITE, rateType: 'MARKET_TRADING', sourceTimeZone: 'Asia/Yangon',
        publicationDate: source.publicationDate, publishedAt: null, publicationPrecision: 'DATE', retrievedAt: snapshot.retrievedAt, expiresAt,
        freshness: source.publicationDate === myanmarDay(current) ? 'PUBLISHED_TODAY' : 'PREVIOUS_PUBLISHED_RATE',
        quotedKrw: '100', mmkPer100Krw: source.marketPer100Krw, mmkPerKrw: source.marketMmkPerKrw,
        referenceMmkPer100Krw: source.referencePer100Krw, referenceMmkPerKrw: source.referenceMmkPerKrw, referenceSourceUrl: CBM_REFERENCE_API,
        krwPerQuotedUnit: '100', mmkUnit: source.marketPer100Krw,
        krwPerMmk: new D(100).div(source.marketPer100Krw).toDecimalPlaces(14, Decimal.ROUND_DOWN).toFixed(), rateDisplayDecimalPlaces: 14,
      };
    },
  };
}
export function convertCbm(input: ConversionRequest, quote: CbmQuote, now = new Date()): CbmConversion {
  validatePairAmount(input);
  checkDate(quote.publicationDate, now);
  const market = rate(quote.mmkPer100Krw), reference = rate(quote.referenceMmkPer100Krw);
  if (quote.provider !== 'cbm' || quote.rateType !== 'MARKET_TRADING' || quote.quotedKrw !== '100' ||
      quote.quoteId !== quoteId(quote.publicationDate, market, reference) ||
      quote.mmkPerKrw !== new D(market).div(100).toFixed() ||
      !Number.isFinite(Date.parse(quote.retrievedAt)) || Date.parse(quote.retrievedAt) > now.getTime()) invalid();
  // Always use the original per-100 quote; never invert a rounded display rate or use the reference value.
  const raw = input.from === 'KRW' ? new D(input.amount).mul(market).div(100) : new D(input.amount).mul(100).div(market);
  const decimalPlaces = input.to === 'KRW' ? 0 : 2;
  const convertedAmount = raw.toFixed(decimalPlaces, Decimal.ROUND_DOWN);
  return { ...input, convertedAmount, belowDisplayPrecision: raw.gt(0) && new D(convertedAmount).eq(0), quote,
    calculationVersion: 'krw-mmk-cbm-market-1', calculationPrecision: 80, rounding: 'FLOOR_ONCE', decimalPlaces };
}
