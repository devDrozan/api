import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

// Uses public synthetic examples only. Never prints requests or financial results.
const supplied = process.env.API_BASE_URL;
let origin;
try {
  const url = new URL(supplied ?? '');
  const local = process.argv.includes('--local') && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error();
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  origin = url.origin;
} catch { console.error('Set API_BASE_URL to an HTTPS origin. Use --local only for a loopback development server.'); process.exit(1); }

async function request(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  if (response.headers.get('cache-control') !== 'no-store') throw new Error(`${path}: missing no-store`);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`${path}: expected JSON`);
  return response.json();
}
function verify(condition, name) { if (!condition) throw new Error(`${name}: unexpected API result`); console.log(`PASS ${name}`); }
const employment = { startDate: '2014-10-02', lastWorkingDate: '2017-09-15', weeklyHours: 40, hasSpecialCircumstances: false };
try {
  // Only health GETs are retried while a sleeping test host wakes. Financial POSTs are never retried here.
  const deadline = Date.now() + 90000;
  while (true) {
    try { const health = await request('/health'); verify(health.status === 'ok' && health.service === 'e9-severance-api', 'health'); break; }
    catch { if (Date.now() >= deadline) throw new Error('API did not become healthy within 90 seconds'); await delay(2000); }
  }
  const rules = await request('/v1/rules'); verify(!!rules, 'rules');
  const context = await request('/v1/calculations/context', { method: 'normal', employment });
  verify(context.employmentDays === 1080 && context.lookbackDays === 92, 'severance context');
  const result = await request('/v1/calculations', {
    method: 'normal', employment,
    wages: [
      { startDate: '2017-06-16', endDate: '2017-06-30', basePay: '1000000', allowances: '180000' },
      { startDate: '2017-07-01', endDate: '2017-07-31', basePay: '2000000', allowances: '360000' },
      { startDate: '2017-08-01', endDate: '2017-08-31', basePay: '2000000', allowances: '360000' },
      { startDate: '2017-09-01', endDate: '2017-09-15', basePay: '1000000', allowances: '180000' },
    ], annualBonus: '4000000', annualLeavePay: '300000',
  });
  verify(result.result?.kind === 'severance' && result.result.referenceWagesKrw === '8155000', 'severance calculation');
  const salary = await request('/v1/salary-estimates', {
    month: '2026-11', settings: { basicSalary: '2000000', normalRate: '10000', overtimeRate: '15000', saturdayRate: '20000', sundayRate: '25000', nightRate: '5000' },
    entries: [
      { date: '2026-11-02', normalHours: '8', overtimeHours: '10', nightHours: '6' },
      { date: '2026-11-07', normalHours: '6', overtimeHours: '2', nightHours: '0' },
      { date: '2026-11-08', normalHours: '4', overtimeHours: '0', nightHours: '0' },
    ],
  });
  verify(salary.amountKrw === '2440000', 'salary calculation');
  const hundi = await request('/v1/currency-conversions/hundi', { from: 'KRW', to: 'MMK', amount: '100000', mmkPerUsd: '4400', usdPerKrw: '1350' });
  verify(hundi.convertedAmount === '325925.92', 'hundi conversion');
  console.log('Core online calculations verified. CBM availability/freshness must be checked separately at deployment.');
} catch (error) { console.error(error instanceof Error ? error.message : 'Deployment verification failed'); process.exitCode = 1; }
