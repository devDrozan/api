import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { estimateSalary, type SalaryRequest } from '../src/salary.js';
const settings = { basicSalary: '2000000', normalRate: '10000', overtimeRate: '15000', saturdayRate: '20000', sundayRate: '25000', nightRate: '5000' };
const input = (): SalaryRequest => ({ month: '2026-11', settings: { ...settings }, entries: [
  { date: '2026-11-02', normalHours: '8', overtimeHours: '10', nightHours: '6' },
  { date: '2026-11-07', normalHours: '6', overtimeHours: '2', nightHours: '0' },
  { date: '2026-11-08', normalHours: '4', overtimeHours: '0', nightHours: '0' },
] });
const server = await buildServer();
afterAll(() => server.close());
describe('user-rate salary estimates', () => {
  it('matches the approved example and does not double-pay normal or weekend overtime', () => {
    const result = estimateSalary(input());
    expect(result.amountKrw).toBe('2440000');
    expect(result.hours).toEqual({ normal: '18', weekdayOvertime: '10', saturday: '8', sunday: '4', night: '6' });
    expect(result.components).toEqual({ base: '2000000', weekdayOvertime: '150000', saturday: '160000', sunday: '100000', night: '30000' });
  });
  it('adds night premiums on weekends and floors only the final sum', () => {
    const body = input(); body.settings = { basicSalary: '0.6', normalRate: '999', overtimeRate: '0.1', saturdayRate: '0.2', sundayRate: '0', nightRate: '0.3' };
    body.entries = [{ date: '2026-11-07', normalHours: '1.25', overtimeHours: '0.25', nightHours: '0.5' }];
    const result = estimateSalary(body);
    expect(result.rawAmountKrw).toBe('1.05'); expect(result.amountKrw).toBe('1');
  });
  it('keeps the entire base with no entries', () => expect(estimateSalary({ ...input(), entries: [] }).amountKrw).toBe('2000000'));
  it('accepts leap days and determines weekdays without device timezone', () => {
    const body = { ...input(), month: '2024-02', entries: [{ date: '2024-02-29', normalHours: '8', overtimeHours: '1', nightHours: '0' }] };
    expect(estimateSalary(body).hours.weekdayOvertime).toBe('1');
  });
  const invalid = [
    ['INVALID_DATE', { date: '2026-11-31' }],
    ['MONTH_MISMATCH', { date: '2026-12-01' }],
    ['DAILY_HOURS_EXCEEDED', { normalHours: '24', overtimeHours: '0.01' }],
    ['NIGHT_HOURS_EXCEEDED', { normalHours: '1', overtimeHours: '0', nightHours: '1.01' }],
    ['INVALID_VALUE', { normalHours: '-1' }],
    ['INVALID_VALUE', { normalHours: '0.001' }],
  ] as const;
  it.each(invalid)('rejects %s with field issues', async (code, patch) => {
    const body = input(); body.entries = [{ ...body.entries[0]!, ...patch }];
    const reply = await server.inject({ method: 'POST', url: '/v1/salary-estimates', payload: body });
    expect(reply.statusCode).toBe(400); expect(reply.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });
  it('rejects duplicate dates', async () => {
    const body = input(); body.entries.push(body.entries[0]!);
    const reply = await server.inject({ method: 'POST', url: '/v1/salary-estimates', payload: body });
    expect(reply.json().issues[0].code).toBe('DUPLICATE_DATE');
  });
  it('rejects invalid months, large rates and excess entries', async () => {
    for (const patch of [{ month: '2026-13' }, { settings: { ...settings, nightRate: '1000000000000000' } }, { entries: Array(32).fill(input().entries[0]) }]) {
      expect((await server.inject({ method: 'POST', url: '/v1/salary-estimates', payload: { ...input(), ...patch } })).statusCode).toBe(400);
    }
  });
  it('serves the complete response without caching', async () => {
    const reply = await server.inject({ method: 'POST', url: '/v1/salary-estimates', payload: input() });
    expect(reply.statusCode).toBe(200); expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.json()).toMatchObject({ amountKrw: '2440000', formulaVersion: 'salary-user-rates-1', rounding: 'FLOOR_ONCE_TO_WHOLE_KRW' });
  });
});
