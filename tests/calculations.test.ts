import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import type { CalculationRequest, ContextRequest } from '../src/schemas.js';
import { calculate, getContext } from '../src/domain.js';

const employment = { startDate: '2014-10-02', lastWorkingDate: '2017-09-15', weeklyHours: 40, hasSpecialCircumstances: false };
const reference: CalculationRequest = {
  method: 'normal', employment,
  wages: [
    { startDate: '2017-06-16', endDate: '2017-06-30', basePay: '1000000', allowances: '180000' },
    { startDate: '2017-07-01', endDate: '2017-07-31', basePay: '2000000', allowances: '360000' },
    { startDate: '2017-08-01', endDate: '2017-08-31', basePay: '2000000', allowances: '360000' },
    { startDate: '2017-09-01', endDate: '2017-09-15', basePay: '1000000', allowances: '180000' },
  ], annualBonus: '4000000', annualLeavePay: '300000',
};

describe('calculation rules', () => {
  it('matches the MOEL worked example using full precision until final rounding', () => {
    const output = calculate(reference);
    expect(output.context.employmentDays).toBe(1080);
    expect(output.context.lookbackDays).toBe(92);
    expect(output.result?.kind).toBe('severance');
    if (output.result?.kind !== 'severance') throw new Error('wrong result');
    expect(output.result.referenceWagesKrw).toBe('8155000');
    expect(Number(output.result.averageDailyWageKrw)).toBeCloseTo(88641.304347826, 7);
    expect(output.result.amountKrw).toBe((8155000n * 30n * 1080n / (92n * 365n)).toString());
    expect(output.result.provisional).toBe(true);
  });
  it('uses the higher ordinary wage for both normal and DB', () => {
    for (const method of ['normal', 'db'] as const) {
      const output = calculate({ ...reference, method, ordinaryDailyWage: '100000' });
      if (output.result?.kind !== 'severance') throw new Error('wrong result');
      expect(output.result.wageBasis).toBe('ordinary');
      expect(output.result.amountKrw).toBe((100000n * 30n * 1080n / 365n).toString());
      expect(output.result.provisional).toBe(false);
    }
  });
  it('includes the final working day and uses a calendar-year eligibility boundary', () => {
    const base = { method: 'normal' as const, employment: { ...employment, startDate: '2023-03-01', lastWorkingDate: '2024-02-28', weeklyHours: 15 } };
    expect(getContext(base).employmentDays).toBe(365);
    expect(getContext(base).eligibility.status).toBe('ineligible');
    expect(getContext({ ...base, employment: { ...base.employment, lastWorkingDate: '2024-02-29' } }).eligibility.status).toBe('eligible');
  });
  it('rejects a zero ordinary wage rather than treating it as a verified wage floor', () => {
    expect(() => calculate({ ...reference, ordinaryDailyWage: '0' })).toThrow();
  });
  it('handles month-end clamping and leap-day wage periods without gaps', () => {
    const context = getContext({ method: 'normal', employment: { ...employment, startDate: '2020-01-01', lastWorkingDate: '2024-05-30' } });
    expect(context.lookbackStart).toBe('2024-02-29');
    expect(context.wagePeriods.reduce((sum, p) => sum + p.days, 0)).toBe(context.lookbackDays);
    expect(context.wagePeriods.at(-1)?.endDate).toBe('2024-05-30');
  });
  it('screens out low hours and returns no total for special histories', () => {
    expect(calculate({ ...reference, employment: { ...employment, weeklyHours: 14.99 } }).status).toBe('ineligible');
    const complex = calculate({ ...reference, employment: { ...employment, hasSpecialCircumstances: true } });
    expect(complex.status).toBe('review_required');
    expect(complex.result).toBeUndefined();
  });
  it('requires the exact generated wage periods, including duplicate detection', () => {
    if (reference.method === 'dc') throw new Error('wrong fixture');
    expect(() => calculate({ ...reference, wages: reference.wages!.slice(0, 3) })).toThrow();
    expect(() => calculate({ ...reference, wages: [reference.wages![0]!, reference.wages![0]!, ...reference.wages!.slice(2)] })).toThrow();
  });
  it('sums DC wages before dividing and separates a lower reported balance', () => {
    const output = calculate({ method: 'dc', employment: { ...employment, startDate: '2024-07-01', lastWorkingDate: '2025-12-31' }, dcWages: [{ year: 2024, wages: '18000000' }, { year: 2025, wages: '36000000' }], reportedBalance: { amount: '4000000', asOf: '2025-12-31' } });
    if (output.result?.kind !== 'dc') throw new Error('wrong result');
    expect(output.result.requiredContributionKrw).toBe('4500000');
    expect(output.result.reportedBalance?.amount).toBe('4000000');
    expect(output.result.years).toHaveLength(2);
  });
  it('rejects incomplete or duplicate DC years', () => {
    const input = { method: 'dc' as const, employment, dcWages: [{ year: 2014, wages: '1000' }] };
    expect(() => calculate(input)).toThrow();
  });
  it('returns review required for a zero reference wage', () => {
    if (reference.method === 'dc') throw new Error('wrong fixture');
    const output = calculate({ ...reference, annualBonus: '0', annualLeavePay: '0', wages: reference.wages!.map(p => ({ ...p, basePay: '0', allowances: '0' })) });
    expect(output.status).toBe('review_required');
    expect(output.result).toBeUndefined();
  });
});

describe('HTTP contract', () => {
  let api: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => { api = await buildServer(); });
  afterAll(async () => { await api.close(); });
  it('returns a versioned result with no-store headers', async () => {
    const response = await api.inject({ method: 'POST', url: '/v1/calculations', payload: reference });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().rulesVersion).toBe('2026.10.29.1');
  });
  it.each(['2025-02-30', '2025-13-01', '2025-00-02'])('rejects invalid calendar date %s', async date => {
    const payload: ContextRequest = { method: 'normal', employment: { ...employment, startDate: date } };
    const response = await api.inject({ method: 'POST', url: '/v1/calculations/context', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().issues[0].code).toBe('INVALID_DATE');
  });
  it('rejects negative money and undeclared properties rather than removing them', async () => {
    const negative = await api.inject({ method: 'POST', url: '/v1/calculations', payload: { ...reference, annualBonus: '-1' } });
    expect(negative.statusCode).toBe(400);
    const extra = await api.inject({ method: 'POST', url: '/v1/calculations/context', payload: { method: 'normal', employment, salarySecret: '123' } });
    expect(extra.statusCode).toBe(400);
  });
  it.each(['normal', 'db'] as const)('rounds %s only after evaluating the full wage fraction', async method => {
    const employment = { startDate: '2023-01-01', lastWorkingDate: '2024-01-03', weeklyHours: 40, hasSpecialCircumstances: false };
    const context = getContext({ method, employment });
    expect(context.employmentDays).toBe(368);
    expect(context.lookbackDays).toBe(92);
    for (const total of ['9124999.999999', '9125000', '9125000.000001', '999999999999999.999999']) {
      const response = await api.inject({ method: 'POST', url: '/v1/calculations', payload: {
        method, employment,
        wages: context.wagePeriods.map((period, index) => ({
          startDate: period.startDate, endDate: period.endDate,
          basePay: index === 0 ? total : '0', allowances: '0',
        })),
      } });
      expect(response.statusCode).toBe(200);
      const [whole, fraction = ''] = total.split('.');
      const scaledWages = BigInt(whole! + fraction.padEnd(6, '0'));
      const expected = scaledWages * 30n * 368n / (1000000n * 92n * 365n);
      expect(response.json().result.amountKrw).toBe(expected.toString());
      if (total === '9125000') {
        expect(response.json().result.rawAmountKrw).toBe('3000000.000000000000');
      }
    }
  });
  it.each(['normal', 'db'] as const)('validates supplied ordinary wages before every %s early return', async method => {
    if (reference.method === 'dc') throw new Error('wrong fixture');
    const cases = [
      { ...reference, method },
      { ...reference, method, employment: { ...employment, weeklyHours: 14 } },
      { ...reference, method, employment: { ...employment, startDate: '2017-01-01' } },
      { ...reference, method, employment: { ...employment, hasSpecialCircumstances: true } },
      { ...reference, method, employment: { ...employment, startDate: '2012-01-01' } },
      { ...reference, method, annualBonus: '0', annualLeavePay: '0', wages: reference.wages!.map(row => ({ ...row, basePay: '0', allowances: '0' })) },
    ];
    for (const payload of cases) {
      for (const ordinaryDailyWage of ['0', null, undefined]) {
        const response = await api.inject({ method: 'POST', url: '/v1/calculations', payload: { ...payload, ordinaryDailyWage } });
        expect(response.statusCode).toBe(ordinaryDailyWage === '0' ? 400 : 200);
        if (ordinaryDailyWage === '0') {
          expect(response.json().code).toBe('INVALID_INPUT');
          expect(response.json().issues).toEqual([{ field: 'ordinaryDailyWage', code: 'POSITIVE_ORDINARY_WAGE' }]);
        }
      }
    }
  });
  it('returns a structured 429 with retry and no-store headers after the request limit', async () => {
    const limitedApi = await buildServer();
    try {
      for (let request = 0; request < 100; request++) {
        const response = await limitedApi.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
      }
      const response = await limitedApi.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ code: 'RATE_LIMITED', message: 'Please try again shortly.', issues: [] });
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await limitedApi.close();
    }
  });
  it('limits forwarded clients separately only when the connecting proxy is trusted', async () => {
    const previous = process.env.TRUSTED_PROXIES;
    process.env.TRUSTED_PROXIES = '127.0.0.1';
    let proxiedApi: Awaited<ReturnType<typeof buildServer>> | undefined;
    try {
      proxiedApi = await buildServer();
      for (let request = 0; request < 102; request++) {
        const response = await proxiedApi.inject({ method: 'GET', url: '/health', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': request % 2 ? '198.51.100.1' : '198.51.100.2' } });
        expect(response.statusCode).toBe(200);
      }
      for (let request = 0; request < 100; request++) {
        const response = await proxiedApi.inject({ method: 'GET', url: '/health', remoteAddress: '203.0.113.10', headers: { 'x-forwarded-for': `198.51.100.${request + 1}` } });
        expect(response.statusCode).toBe(200);
      }
      const spoofed = await proxiedApi.inject({ method: 'GET', url: '/health', remoteAddress: '203.0.113.10', headers: { 'x-forwarded-for': '198.51.100.250' } });
      expect(spoofed.statusCode).toBe(429);
    } finally {
      await proxiedApi?.close();
      if (previous === undefined) delete process.env.TRUSTED_PROXIES;
      else process.env.TRUSTED_PROXIES = previous;
    }
  });
  it('allows only configured web origins', async () => {
    const response = await api.inject({ method: 'OPTIONS', url: '/v1/calculations', headers: { origin: 'https://untrusted.example', 'access-control-request-method': 'POST' } });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
