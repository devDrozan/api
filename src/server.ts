import { configuredRemoteConfig, RemoteConfigSchema } from './remote-config.js';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { calculate, getContext, InputError } from './domain.js';
import { CalculationInput, CalculationResponse, ContextInput, ContextResponse, ErrorResponse, RulesResponse, type CalculationRequest, type ContextRequest } from './schemas.js';
import { SalaryInput, SalaryResponse, estimateSalary, type SalaryRequest } from './salary.js';
import { ConversionInput, ConversionResponse, ExchangeQuote, ExchangeError, configuredRateService, convertCurrency, convertHundi, validatePairAmount, HundiInput, HundiResponse, type ConversionRequest, type HundiRequest, type Quote } from './exchange.js';
import { Type } from '@sinclair/typebox';
import { RULES } from './rules.js';
import { CbmError, CbmQuoteSchema, CbmConversionSchema, createCbmService, convertCbm, type CbmQuote } from './cbm.js';
import { getRemittanceRate } from './remittance.js';

export async function buildServer(options: { exchange?: { quote: (refresh?: boolean) => Promise<Quote> }; cbm?: { quote: (refresh?: boolean) => Promise<CbmQuote> }; now?: () => Date } = {}) {
  const remoteConfig = configuredRemoteConfig();
  const exchange = options.exchange ?? configuredRateService();
  const cbm = options.cbm ?? createCbmService({ now: options.now });
  const trustedProxies = (process.env.TRUSTED_PROXIES ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const server = Fastify({ logger: false, bodyLimit: 32_768, trustProxy: trustedProxies.length ? trustedProxies : false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const origins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8081,http://127.0.0.1:8081').split(',').map(v => v.trim()).filter(Boolean);
  await server.register(cors, { origin: origins, methods: ['GET', 'POST'], credentials: false });
  await server.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await server.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'ထွယ်ဂျီဂွမ်Caculator API', version: '1.0.0' }, servers: [{ url: 'http://127.0.0.1:3001' }] } });
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof CbmError) {
      const code = ['CBM_STALE_PUBLICATION'].includes(error.code) ? 'RATE_EXPIRED' : ['CBM_RATE_LIMITED', 'CBM_RETRY_LATER'].includes(error.code) ? 'RATE_LIMITED' : error.code === 'CBM_TIMEOUT' ? 'TIMEOUT' : ['CBM_NETWORK_ERROR', 'CBM_HTTP_ERROR'].includes(error.code) ? 'RATE_UNAVAILABLE' : 'UPSTREAM_INVALID_RESPONSE';
      if (code === 'RATE_LIMITED') reply.header('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      return reply.code(code === 'RATE_LIMITED' ? 429 : 503).send({ code, message: 'The CBM rate could not be verified.', issues: [] });
    }
    if (error instanceof ExchangeError) return reply.code(error.status).send({ code: error.code, message: 'The currency request could not be completed.', issues: error.field ? [{ field: error.field, code: error.code }] : [] });
    if (error instanceof InputError) return reply.code(400).send({ code: 'INVALID_INPUT', message: error.message, issues: error.issues });
    const failure = error as FastifyError;
    if (failure.validation && ['/v1/currency-conversions', '/v1/currency-conversions/hundi', '/v1/currency-conversions/cbm'].includes(_request.routeOptions.url ?? '')) {
      const fields = failure.validation.map(value => value.instancePath.slice(1) || String(value.params.missingProperty ?? ''));
      const field = ['from', 'to', 'amount', 'mmkPerUsd', 'usdPerKrw'].find(name => fields.includes(name)) ?? '';
      if (field) { const code = field === 'amount' ? 'INVALID_AMOUNT' : field === 'mmkPerUsd' ? 'INVALID_HUNDI_RATE' : field === 'usdPerKrw' ? 'INVALID_USD_KRW_RATE' : 'UNSUPPORTED_CURRENCY_PAIR'; return reply.code(400).send({ code, message: 'Please check the currency input.', issues: [{ field, code }] }); }
    }
    if (failure.validation) return reply.code(400).send({
      code: 'INVALID_INPUT', message: 'Please check the submitted information.',
      issues: failure.validation.map(v => ({ field: `${v.instancePath.replace(/^\//, '').replaceAll('/', '.')}${v.params.missingProperty ? `.${v.params.missingProperty}` : ''}`.replace(/^\./, ''), code: 'INVALID_VALUE' })),
    });
    if (failure.statusCode === 429) return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Please try again shortly.', issues: [] });
    return reply.code(failure.statusCode && failure.statusCode < 500 ? failure.statusCode : 500).send({ code: 'REQUEST_FAILED', message: 'The request could not be completed.', issues: [] });
  });
  server.get('/v1/remittance-rates/krw-mmk', async (_request, reply) => {
  try {
    const rate = await getRemittanceRate();

    if (!rate) {
      return reply.code(404).send({
        code: 'RATE_NOT_AVAILABLE',
        message: 'No remittance rate available',
      });
    }

    return rate;
  } catch {
    return reply.code(503).send({
      code: 'RATE_UNAVAILABLE',
      message: 'Remittance rate is temporarily unavailable',
    });
  }
});
  server.get('/health', { schema: { operationId: 'health' } }, async () => ({ status: 'ok', service: 'e9-severance-api' }));
  server.get('/v1/mobile-config', { schema: { operationId: 'getMobileConfig', response: { 200: RemoteConfigSchema } } }, async () => remoteConfig);
  server.get('/v1/rules', { schema: { operationId: 'getRules', response: { 200: RulesResponse } } }, async () => RULES);
  server.post<{ Body: ContextRequest }>('/v1/calculations/context', { schema: { operationId: 'getCalculationContext', body: ContextInput, response: { 200: ContextResponse, 400: ErrorResponse } } }, async request => getContext(request.body));
  server.post<{ Body: CalculationRequest }>('/v1/calculations', { schema: { operationId: 'calculate', body: CalculationInput, response: { 200: CalculationResponse, 400: ErrorResponse } } }, async request => calculate(request.body));
  server.post<{ Body: SalaryRequest }>('/v1/salary-estimates', { schema: { operationId: 'estimateSalary', body: SalaryInput, response: { 200: SalaryResponse, 400: ErrorResponse } } }, async request => estimateSalary(request.body));
  server.get<{ Querystring: { refresh?: 'true' | 'false' } }>('/v1/exchange-rates/krw-mmk', { schema: { operationId: 'getKrwMmkRate', querystring: Type.Object({ refresh: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])) }, { additionalProperties: false }), response: { 200: ExchangeQuote, 400: ErrorResponse, 429: ErrorResponse, 503: ErrorResponse } } }, async request => exchange.quote(request.query.refresh === 'true'));
  server.post<{ Body: ConversionRequest }>('/v1/currency-conversions', { schema: { operationId: 'convertCurrency', body: ConversionInput, response: { 200: ConversionResponse, 400: ErrorResponse, 429: ErrorResponse, 503: ErrorResponse } } }, async request => { validatePairAmount(request.body); return convertCurrency(request.body, await exchange.quote(), options.now?.() ?? new Date()); });
  server.post<{ Body: HundiRequest }>('/v1/currency-conversions/hundi', { schema: { operationId: 'convertCurrencyHundi', body: HundiInput, response: { 200: HundiResponse, 400: ErrorResponse, 429: ErrorResponse, 503: ErrorResponse } } }, async request => convertHundi(request.body));
  server.get<{ Querystring: { refresh?: 'true' | 'false' } }>('/v1/exchange-rates/krw-mmk/cbm', { schema: { operationId: 'getCbmKrwMmkRate', querystring: Type.Object({ refresh: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])) }, { additionalProperties: false }), response: { 200: CbmQuoteSchema, 400: ErrorResponse, 429: ErrorResponse, 503: ErrorResponse } } }, async request => cbm.quote(request.query.refresh === 'true'));
  server.post<{ Body: ConversionRequest }>('/v1/currency-conversions/cbm', { schema: { operationId: 'convertCurrencyCbm', body: ConversionInput, response: { 200: CbmConversionSchema, 400: ErrorResponse, 429: ErrorResponse, 503: ErrorResponse } } }, async request => { validatePairAmount(request.body); return convertCbm(request.body, await cbm.quote(), options.now?.() ?? new Date()); });
  await server.ready();
  return server;
}
