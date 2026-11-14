import { Type, type Static } from '@sinclair/typebox';
import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';
const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_DOWN, toExpNeg: -100, toExpPos: 100 });
const currency = Type.Union([Type.Literal('KRW'), Type.Literal('MMK')]);
export const ConversionInput = Type.Object({ from: currency, to: currency, amount: Type.String({ maxLength: 18 }) }, { additionalProperties: false });
export type ConversionRequest = Static<typeof ConversionInput>;
export const ExchangeQuote = Type.Object({
  quoteId: Type.String(), provider: Type.Union([Type.Literal('kb'), Type.Literal('kmb'), Type.Literal('hana')]), sourceName: Type.String(), sourceUrl: Type.String(), rateType: Type.Literal('REFERENCE'),
  publicationDate: Type.String(), publishedAt: Type.Union([Type.String(), Type.Null()]), publicationPrecision: Type.Union([Type.Literal('DATE'), Type.Literal('SECOND')]),
  retrievedAt: Type.String(), expiresAt: Type.String(), freshness: Type.Union([Type.Literal('PUBLISHED_TODAY'), Type.Literal('PREVIOUS_PUBLISHED_RATE')]),
  krwPerQuotedUnit: Type.String(), mmkUnit: Type.String(), mmkPerKrw: Type.String(), krwPerMmk: Type.String(), rateDisplayDecimalPlaces: Type.Literal(12),
});
export type Quote = Static<typeof ExchangeQuote>;
export const ConversionResponse = Type.Object({ from: currency, to: currency, amount: Type.String(), convertedAmount: Type.String(), belowDisplayPrecision: Type.Boolean(), quote: ExchangeQuote,
  calculationVersion: Type.Literal('krw-mmk-reference-1'), calculationPrecision: Type.Literal(80), rounding: Type.Literal('FLOOR_ONCE'), decimalPlaces: Type.Union([Type.Literal(0), Type.Literal(2)]),
});
export type Conversion = Static<typeof ConversionResponse>;
export class ExchangeError extends Error {
  constructor(public code: 'INVALID_AMOUNT' | 'UNSUPPORTED_CURRENCY_PAIR' | 'RATE_UNAVAILABLE' | 'RATE_EXPIRED' | 'RATE_LIMITED' | 'UPSTREAM_INVALID_RESPONSE' | 'INVALID_HUNDI_RATE' | 'INVALID_USD_KRW_RATE', public status = 503, public field = '') { super(code); }
}
export const sources = {
  kb: { name: 'KB Kookmin Bank', url: 'https://obank.kbstar.com/quics?page=C101423' },
  kmb: { name: 'Korea Money Brokerage Corp.', url: 'https://www.kmbco.com/kor/rate/financial_rate.do' },
  hana: { name: 'Hana Bank', url: 'https://www.kebhana.com/cont/mall/mall15/mall1501/index.jsp' },
} as const;
export type Provider = keyof typeof sources;
export type RawQuote = { provider: Provider; rateType: 'REFERENCE'; publicationDate: string; publishedAt?: string | null; krwPerQuotedUnit: string; mmkUnit: string };
const dayMs = 86_400_000;
function koreaDate(now: Date) { return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10); }
function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^(19|20)\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function validatePairAmount(input: ConversionRequest) {
  if (!['KRW', 'MMK'].includes(input.from) || !['KRW', 'MMK'].includes(input.to) || input.from === input.to) throw new ExchangeError('UNSUPPORTED_CURRENCY_PAIR', 400, 'to');
  if (typeof input.amount !== 'string' || !/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/.test(input.amount)) throw new ExchangeError('INVALID_AMOUNT', 400, 'amount');
}
export function normalizeQuote(value: unknown, now = new Date(), expectedProvider?: Provider): Quote {
  if (!value || typeof value !== 'object') throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const row = value as RawQuote;
  if (row.rateType !== 'REFERENCE' || typeof row.provider !== 'string' || !Object.hasOwn(sources, row.provider) || expectedProvider && row.provider !== expectedProvider || !validDate(row.publicationDate) || typeof row.krwPerQuotedUnit !== 'string' || !/^(0|[1-9]\d{0,14})(\.\d{1,18})?$/.test(row.krwPerQuotedUnit) || typeof row.mmkUnit !== 'string' || !/^(0|[1-9]\d{0,8})(\.\d{1,18})?$/.test(row.mmkUnit) || new D(row.krwPerQuotedUnit).lte(0) || new D(row.mmkUnit).lte(0)) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const age = (Date.parse(`${koreaDate(now)}T00:00:00Z`) - Date.parse(`${row.publicationDate}T00:00:00Z`)) / dayMs;
  if (age < 0) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  if (age > 3) throw new ExchangeError('RATE_EXPIRED');
  const publishedAt = row.publishedAt ?? null;
  if (publishedAt !== null && (typeof publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt)) || Date.parse(publishedAt) > now.getTime() || koreaDate(new Date(publishedAt)) !== row.publicationDate)) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const source = sources[row.provider];
  const quoteId = createHash('sha256').update(JSON.stringify([row.provider, row.publicationDate, publishedAt, row.krwPerQuotedUnit, row.mmkUnit])).digest('hex');
  return { quoteId, provider: row.provider, sourceName: source.name, sourceUrl: source.url, rateType: 'REFERENCE', publicationDate: row.publicationDate, publishedAt, publicationPrecision: publishedAt ? 'SECOND' : 'DATE', retrievedAt: now.toISOString(), expiresAt: new Date(Date.parse(`${row.publicationDate}T00:00:00+09:00`) + 4 * dayMs).toISOString(), freshness: age === 0 ? 'PUBLISHED_TODAY' : 'PREVIOUS_PUBLISHED_RATE', krwPerQuotedUnit: row.krwPerQuotedUnit, mmkUnit: row.mmkUnit,
    mmkPerKrw: new D(row.mmkUnit).div(row.krwPerQuotedUnit).toDecimalPlaces(12).toFixed(), krwPerMmk: new D(row.krwPerQuotedUnit).div(row.mmkUnit).toDecimalPlaces(12).toFixed(), rateDisplayDecimalPlaces: 12 };
}
export function convertCurrency(input: ConversionRequest, quote: Quote, now = new Date()): Conversion {
  validatePairAmount(input);
  // Revalidate the original quote, not a rounded display rate or client-provided rate.
  const checked = normalizeQuote(quote, now, quote.provider);
  if (quote.quoteId !== checked.quoteId || !Number.isFinite(Date.parse(quote.retrievedAt)) || Date.parse(quote.retrievedAt) > now.getTime()) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const raw = input.from === 'KRW' ? new D(input.amount).mul(quote.mmkUnit).div(quote.krwPerQuotedUnit) : new D(input.amount).mul(quote.krwPerQuotedUnit).div(quote.mmkUnit);
  const decimalPlaces = input.to === 'KRW' ? 0 : 2;
  const convertedAmount = raw.toFixed(decimalPlaces, D.ROUND_DOWN);
  return { ...input, convertedAmount, belowDisplayPrecision: raw.gt(0) && new D(convertedAmount).eq(0), quote: { ...checked, retrievedAt: quote.retrievedAt }, calculationVersion: 'krw-mmk-reference-1', calculationPrecision: 80, rounding: 'FLOOR_ONCE', decimalPlaces };
}
export const HundiInput = Type.Object({ from: currency, to: currency, amount: Type.String({ maxLength: 18 }), mmkPerUsd: Type.String({ maxLength: 18 }), usdPerKrw: Type.String({ maxLength: 18 }) }, { additionalProperties: false });
export type HundiRequest = Static<typeof HundiInput>;
export const HundiResponse = Type.Object({ from: currency, to: currency, amount: Type.String(), convertedAmount: Type.String(), belowDisplayPrecision: Type.Boolean(), rates: Type.Object({ mmkPerUsd: Type.String(), usdPerKrw: Type.String(), mmkPerKrw: Type.String() }), calculationVersion: Type.Literal('krw-mmk-hundi-1'), calculationPrecision: Type.Literal(80), rounding: Type.Literal('FLOOR_ONCE'), decimalPlaces: Type.Union([Type.Literal(0), Type.Literal(2)]) });
export type HundiConversion = Static<typeof HundiResponse>;
const userRate = /^(0|[1-9]\d{0,5})(\.\d{1,4})?$/;
function validateUserRate(value: string, field: 'mmkPerUsd' | 'usdPerKrw') {
  if (typeof value !== 'string' || !userRate.test(value) || new D(value).lte(0)) throw new ExchangeError(field === 'mmkPerUsd' ? 'INVALID_HUNDI_RATE' : 'INVALID_USD_KRW_RATE', 400, field);
}
// User-rate (hundi) conversion: KRW → MMK = amount × MMK/USD ÷ USD/KRW, and the exact inverse.
// Every operation stays on the user's decimal rates; no display-rounded rate is reused.
export function convertHundi(input: HundiRequest): HundiConversion {
  validatePairAmount(input);
  validateUserRate(input.mmkPerUsd, 'mmkPerUsd');
  validateUserRate(input.usdPerKrw, 'usdPerKrw');
  const hundi = new D(input.mmkPerUsd), usd = new D(input.usdPerKrw);
  const raw = input.from === 'KRW' ? new D(input.amount).mul(hundi).div(usd) : new D(input.amount).mul(usd).div(hundi);
  const decimalPlaces = input.to === 'KRW' ? 0 : 2;
  const convertedAmount = raw.toFixed(decimalPlaces, D.ROUND_DOWN);
  return { ...input, convertedAmount, belowDisplayPrecision: raw.gt(0) && new D(convertedAmount).eq(0), rates: { mmkPerUsd: hundi.toFixed(), usdPerKrw: usd.toFixed(), mmkPerKrw: hundi.div(usd).toDecimalPlaces(12).toFixed() }, calculationVersion: 'krw-mmk-hundi-1', calculationPrecision: 80, rounding: 'FLOOR_ONCE', decimalPlaces };
}
export type QuoteLoader = () => Promise<unknown>;
export function createRateService(loader: QuoteLoader, provider: Provider, now = () => new Date()) {
  let cached: Quote | undefined;
  let pending: Promise<Quote> | undefined;
  let attemptedAt = -Infinity;
  return {
    async quote(refresh = false): Promise<Quote> {
      const current = now();
      if (pending) return pending;
      if (cached && (!refresh || current.getTime() - attemptedAt < 60_000) && current.getTime() - Date.parse(cached.retrievedAt) < 900_000) {
        const checked = normalizeQuote(cached, current, provider);
        return { ...checked, retrievedAt: cached.retrievedAt };
      }
      if (current.getTime() - attemptedAt < 60_000) throw new ExchangeError('RATE_LIMITED', 429);
      attemptedAt = current.getTime();
      const operation = (async () => {
        try { const value = await loader(); cached = normalizeQuote(value, now(), provider); return cached; }
        catch (error) {
          // A failed retrieval never makes cached metadata newer. Expired/invalid data is not reused.
          if (error instanceof ExchangeError && ['UPSTREAM_INVALID_RESPONSE', 'RATE_EXPIRED', 'RATE_LIMITED'].includes(error.code)) throw error;
          if (cached && now().getTime() - Date.parse(cached.retrievedAt) < 900_000) { const checked = normalizeQuote(cached, now(), provider); return { ...checked, retrievedAt: cached.retrievedAt }; }
          throw new ExchangeError('RATE_UNAVAILABLE');
        }
      })();
      pending = operation;
      try { return await operation; } finally { if (pending === operation) pending = undefined; }
    },
  };
}
// Official reference rates come from Korean publications. KB is the primary
// source; KMB (the official interbank broker) is the failover. Every quote keeps
// its own provider, attribution, publication time, and retrieval time, so a
// failover is visible instead of silently mixing sources.
export const kbEndpoint = 'https://obank.kbstar.com/quics?page=C101423';
export const hanaEndpoint = 'https://www.kebhana.com/cms/rate/wpfxd651_01i_01.do';
export const kmbEndpoint = 'https://www.kmbco.com/kor/rate/financial_rate.do';
const browserHeaders = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
async function readText(response: Response, kind: 'json' | 'html', maxBytes: number): Promise<string> {
  if (response.status === 429) { await response.body?.cancel(); throw new ExchangeError('RATE_LIMITED', 429); }
  if (!response.ok) { await response.body?.cancel(); throw new ExchangeError('RATE_UNAVAILABLE'); }
  if (!response.headers.get('content-type')?.toLowerCase().includes(kind === 'json' ? 'json' : 'text/html') || Number(response.headers.get('content-length') ?? 0) > maxBytes) { await response.body?.cancel(); throw new ExchangeError('UPSTREAM_INVALID_RESPONSE'); }
  if (!response.body) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new ExchangeError('UPSTREAM_INVALID_RESPONSE'); } chunks.push(chunk.value); }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) { if (error instanceof ExchangeError) throw error; if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw new ExchangeError('RATE_UNAVAILABLE'); throw new ExchangeError('UPSTREAM_INVALID_RESPONSE'); }
  finally { reader.releaseLock(); }
}
async function readJson(response: Response): Promise<unknown> {
  try { return JSON.parse(await readText(response, 'json', 65536)) as unknown; }
  catch (error) { if (error instanceof ExchangeError) throw error; throw new ExchangeError('UPSTREAM_INVALID_RESPONSE'); }
}
const baseRate = /^(0|[1-9]\d{0,14})(\.\d{1,18})?$/;
function koreanBaseRate(value: string | undefined): string {
  const rate = value?.replaceAll(',', '');
  // Reject a missing, zero, or implausible MMK base rate (roughly 0.05–5 KRW per kyat).
  if (!rate || !baseRate.test(rate) || new D(rate).lt(0.05) || new D(rate).gt(5)) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  return rate;
}
function rowAround(html: string, marker: string, limit: number) {
  const at = html.indexOf(marker);
  if (at < 0) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const end = html.indexOf('</tr>', at);
  return html.slice(at, end < 0 ? Math.min(html.length, at + limit) : end);
}
// KB publishes the daily table server-side: 통화종류 / 매매기준율 / 송금 / 현찰 / USD환산율,
// with the rate-registration stamp and round in a separate summary table. MMK is
// quoted per 1 kyat, so the first numeric cell is the KRW-per-MMK base rate.
export function parseKbQuote(html: string): RawQuote {
  const stamp = /<td>\s*((?:19|20)\d{2})\.(\d{2})\.(\d{2})(?:&nbsp;|&#160;|\s)+(\d{2}):(\d{2}):(\d{2})\s*\(\d+\s*회차\)\s*<\/td>/.exec(html);
  if (!stamp) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const [, y, m, d, hh, mm, ss] = stamp as unknown as [string, string, string, string, string, string, string];
  const row = rowAround(html, "uf_goLink('MMK')", 1600);
  if (!row.includes('미얀마')) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const cells = [...row.matchAll(/<td class="tRight">\s*([\d,.]+)\s*<\/td>/g)].map(match => match[1]);
  const publicationDate = `${y}-${m}-${d}`;
  if (!validDate(publicationDate)) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  return { provider: 'kb', rateType: 'REFERENCE', publicationDate, publishedAt: `${publicationDate}T${hh}:${mm}:${ss}+09:00`, krwPerQuotedUnit: koreanBaseRate(cells[0]), mmkUnit: '1' };
}
// KMB publishes the official interbank 대원화환율 for the 기준일자: the third column
// of the MMK row is KRW per 1 kyat. Only the date is published, so no time is invented.
export function parseKmbQuote(html: string): RawQuote {
  const date = /<dt>\s*기준일자\s*<\/dt>\s*<dd>\s*((?:19|20)\d{2}-\d{2}-\d{2})\s*<\/dd>/.exec(html)?.[1];
  if (!date || !validDate(date)) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const row = /<td>\s*미얀마\s*짯\(MMK\)\s*<\/td>\s*<td>\s*[\d,.]+\s*<\/td>\s*<td>\s*([\d,.]+)\s*<\/td>/.exec(html)?.[1];
  return { provider: 'kmb', rateType: 'REFERENCE', publicationDate: date, krwPerQuotedUnit: koreanBaseRate(row), mmkUnit: '1' };
}
// Hana's 현재환율 fragment is an AJAX POST result. The table's numeric cells are
// 현찰 사실때/spread, 현찰 파실때/spread, 송금 보낼때/받을때, 외화수표 파실때,
// 매매기준율, 환가료율, 미화환산율 — the base rate is the eighth cell (index 7).
export function parseHanaQuote(html: string): RawQuote {
  const stamp = /고시일시<\/em>\s*:\s*<strong>\s*((?:19|20)\d{2})년(\d{1,2})월(\d{1,2})일\s*<\/strong>\s*<strong>\s*(\d{1,2})시(\d{1,2})분(\d{1,2})초/.exec(html);
  if (!stamp) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const [, y, m, d, hh, mm, ss] = stamp as unknown as [string, string, string, string, string, string, string];
  const row = /goFluctuation\('MMK'[\s\S]*?<\/tr>/.exec(html)?.[0];
  if (!row || !row.includes('미얀마')) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const cells = [...row.matchAll(/<td class="txtAr">\s*([\d,.]+)\s*<\/td>/g)].map(match => match[1]);
  if (cells.length < 8) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  const publicationDate = `${y}-${m}-${d}`;
  if (!validDate(publicationDate)) throw new ExchangeError('UPSTREAM_INVALID_RESPONSE');
  return { provider: 'hana', rateType: 'REFERENCE', publicationDate, publishedAt: `${publicationDate}T${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}+09:00`, krwPerQuotedUnit: koreanBaseRate(cells[7]), mmkUnit: '1' };
}
export const hanaLoaderFor = (clock: () => Date): QuoteLoader => async () => {
  const day = koreaDate(clock());
  const body = new URLSearchParams({ ajax: 'true', curCd: '', tmpInqStrDt: day, pbldDvCd: '3', pbldSqn: '', inqStrDt: day.replaceAll('-', ''), inqKindCd: '1', requestTarget: 'searchContentDiv' }).toString();
  const response = await fetch(hanaEndpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
    cache: 'no-store',
    headers: { ...browserHeaders, Accept: 'text/javascript, text/html, application/xml, text/xml, */*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.kebhana.com/cms/rate/index.do?contentUrl=/cms/rate/wpfxd651_01i.do' },
    body,
  });
  return parseHanaQuote(await readText(response, 'html', 262_144));
};
export const hanaLoader: QuoteLoader = hanaLoaderFor(() => new Date());
export const kbLoader: QuoteLoader = async () => parseKbQuote(await readText(await fetch(kbEndpoint, { signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store', headers: browserHeaders }), 'html', 524_288));
export const kmbLoader: QuoteLoader = async () => parseKmbQuote(await readText(await fetch(kmbEndpoint, { signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store', headers: browserHeaders }), 'html', 262_144));
export type RateService = { quote: (refresh?: boolean) => Promise<Quote> };
const unavailable = (): RateService => ({ quote: async (_refresh = false): Promise<Quote> => { throw new ExchangeError('RATE_UNAVAILABLE'); } });
// Try each configured source in order. Each source keeps its own cache/throttle, so
// a failing primary is retried at most once a minute while the fallback serves.
export function createFailoverService(services: RateService[]): RateService {
  return {
    async quote(refresh = false) {
      let allExpired = services.length > 0;
      for (const service of services) {
        try { return await service.quote(refresh); }
        catch (error) { if (!(error instanceof ExchangeError) || error.code !== 'RATE_EXPIRED') allExpired = false; }
      }
      throw new ExchangeError(allExpired ? 'RATE_EXPIRED' : 'RATE_UNAVAILABLE');
    },
  };
}
// Licensed institutional feed: a normalized JSON quote served by an operator-owned
// adapter (for example Hana Open API once credentials are issued). The API never
// calls a bank's authenticated endpoint directly with unreviewed schemas.
function licensedRateService(env: NodeJS.ProcessEnv, now?: () => Date): RateService | undefined {
  if (env.EXCHANGE_RATE_ACCESS_APPROVED !== 'true' || !env.EXCHANGE_RATE_FEED_URL) return undefined;
  const provider = env.EXCHANGE_RATE_FEED_PROVIDER === 'kb' || env.EXCHANGE_RATE_FEED_PROVIDER === 'kmb' ? env.EXCHANGE_RATE_FEED_PROVIDER : 'hana';
  let url: URL;
  try { url = new URL(env.EXCHANGE_RATE_FEED_URL); if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error(); }
  catch { return undefined; }
  const loader: QuoteLoader = async () => readJson(await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json', ...(env.EXCHANGE_RATE_FEED_TOKEN ? { Authorization: `Bearer ${env.EXCHANGE_RATE_FEED_TOKEN}` } : {}) } }));
  return createRateService(loader, provider, now);
}
// `auto` (default) tries KB, then a licensed feed when configured, then KMB.
// `kb`/`kmb`/`hana` pin one source; `none` disables official conversion entirely.
export function configuredRateService(env: NodeJS.ProcessEnv = process.env, options: { kb?: QuoteLoader; kmb?: QuoteLoader; now?: () => Date } = {}): RateService {
  const selected = env.EXCHANGE_RATE_PROVIDER ?? 'auto';
  const kb = () => createRateService(options.kb ?? kbLoader, 'kb', options.now);
  const kmb = () => createRateService(options.kmb ?? kmbLoader, 'kmb', options.now);
  if (selected === 'none') return unavailable();
  if (selected === 'kb') return kb();
  if (selected === 'kmb') return kmb();
  if (selected === 'hana') return licensedRateService(env, options.now) ?? unavailable();
  if (selected !== 'auto') return unavailable();
  const services: RateService[] = [kb()];
  const licensed = licensedRateService(env, options.now);
  if (licensed) services.push(licensed);
  services.push(kmb());
  return createFailoverService(services);
}
