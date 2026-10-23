import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { calculate, getContext, InputError } from './domain.js';
import { CalculationInput, CalculationResponse, ContextInput, ContextResponse, ErrorResponse, RulesResponse, type CalculationRequest, type ContextRequest } from './schemas.js';
import { RULES } from './rules.js';

export async function buildServer() {
  const server = Fastify({ logger: false, bodyLimit: 32_768, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const origins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8081,http://127.0.0.1:8081').split(',').map(v => v.trim()).filter(Boolean);
  await server.register(cors, { origin: origins, methods: ['GET', 'POST'], credentials: false });
  await server.register(rateLimit, { max: 100, timeWindow: '1 minute', errorResponseBuilder: () => ({ code: 'RATE_LIMITED', message: 'Please try again shortly.', issues: [] }) });
  await server.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'ထွယ်ဂျီဂွမ်Caculator API', version: '1.0.0' }, servers: [{ url: 'http://127.0.0.1:3001' }] } });
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof InputError) return reply.code(400).send({ code: 'INVALID_INPUT', message: error.message, issues: error.issues });
    const failure = error as FastifyError;
    if (failure.validation) return reply.code(400).send({
      code: 'INVALID_INPUT', message: 'Please check the submitted information.',
      issues: failure.validation.map(v => ({ field: `${v.instancePath.replace(/^\//, '').replaceAll('/', '.')}${v.params.missingProperty ? `.${v.params.missingProperty}` : ''}`.replace(/^\./, ''), code: 'INVALID_VALUE' })),
    });
    if (failure.statusCode === 429) return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Please try again shortly.', issues: [] });
    return reply.code(failure.statusCode && failure.statusCode < 500 ? failure.statusCode : 500).send({ code: 'REQUEST_FAILED', message: 'The request could not be completed.', issues: [] });
  });
  server.get('/health', { schema: { operationId: 'health' } }, async () => ({ status: 'ok', service: 'e9-severance-api' }));
  server.get('/v1/rules', { schema: { operationId: 'getRules', response: { 200: RulesResponse } } }, async () => RULES);
  server.post<{ Body: ContextRequest }>('/v1/calculations/context', { schema: { operationId: 'getCalculationContext', body: ContextInput, response: { 200: ContextResponse, 400: ErrorResponse } } }, async request => getContext(request.body));
  server.post<{ Body: CalculationRequest }>('/v1/calculations', { schema: { operationId: 'calculate', body: CalculationInput, response: { 200: CalculationResponse, 400: ErrorResponse } } }, async request => calculate(request.body));
  await server.ready();
  return server;
}
