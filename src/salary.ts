import { Type, type Static } from '@sinclair/typebox';
import { Decimal } from 'decimal.js';
import { InputError } from './domain.js';

const Money = Type.String({ pattern: '^(0|[1-9]\\d{0,14})(\\.\\d{1,6})?$' });
const Hours = Type.String({ pattern: '^(0|[1-9]\\d?)(\\.\\d{1,2})?$' });
export const SalarySettings = Type.Object({ basicSalary: Money, normalRate: Money, overtimeRate: Money, saturdayRate: Money, sundayRate: Money, nightRate: Money }, { additionalProperties: false });
export const SalaryInput = Type.Object({
  month: Type.String({ pattern: '^(19|20)\\d{2}-(0[1-9]|1[0-2])$' }),
  settings: SalarySettings,
  entries: Type.Array(Type.Object({ date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), normalHours: Hours, overtimeHours: Hours, nightHours: Hours }, { additionalProperties: false }), { maxItems: 31 }),
}, { additionalProperties: false });
const Amounts = Type.Object({ base: Type.String(), weekdayOvertime: Type.String(), saturday: Type.String(), sunday: Type.String(), night: Type.String() });
export const SalaryResponse = Type.Object({ month: Type.String(), currency: Type.Literal('KRW'), formulaVersion: Type.String(), rounding: Type.String(), assumptions: Type.Array(Type.String()), hours: Type.Object({ normal: Type.String(), weekdayOvertime: Type.String(), saturday: Type.String(), sunday: Type.String(), night: Type.String() }), components: Amounts, rawAmountKrw: Type.String(), amountKrw: Type.String() });
export type SalaryRequest = Static<typeof SalaryInput>;
const D = Decimal.clone({ precision: 40 });
export function estimateSalary(input: SalaryRequest): Static<typeof SalaryResponse> {
  const issues: {field: string; code: string}[] = [];
  const seen = new Set<string>();
  const hours = { normal: new D(0), weekdayOvertime: new D(0), saturday: new D(0), sunday: new D(0), night: new D(0) };
  input.entries.forEach((entry, index) => {
    const field = `entries.${index}`;
    const date = new Date(`${entry.date}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== entry.date) issues.push({ field: `${field}.date`, code: 'INVALID_DATE' });
    if (!entry.date.startsWith(`${input.month}-`)) issues.push({ field: `${field}.date`, code: 'MONTH_MISMATCH' });
    if (seen.has(entry.date)) issues.push({ field: `${field}.date`, code: 'DUPLICATE_DATE' });
    seen.add(entry.date);
    const normal = new D(entry.normalHours), overtime = new D(entry.overtimeHours), night = new D(entry.nightHours);
    const worked = normal.plus(overtime);
    if (worked.gt(24)) issues.push({ field: `${field}.overtimeHours`, code: 'DAILY_HOURS_EXCEEDED' });
    if (night.gt(worked)) issues.push({ field: `${field}.nightHours`, code: 'NIGHT_HOURS_EXCEEDED' });
    hours.normal = hours.normal.plus(normal);
    hours.night = hours.night.plus(night);
    if (date.getUTCDay() === 6) hours.saturday = hours.saturday.plus(worked);
    else if (date.getUTCDay() === 0) hours.sunday = hours.sunday.plus(worked);
    else hours.weekdayOvertime = hours.weekdayOvertime.plus(overtime);
  });
  if (issues.length) throw new InputError(issues);
  const s = input.settings;
  const components = { base: s.basicSalary, weekdayOvertime: hours.weekdayOvertime.times(s.overtimeRate).toFixed(), saturday: hours.saturday.times(s.saturdayRate).toFixed(), sunday: hours.sunday.times(s.sundayRate).toFixed(), night: hours.night.times(s.nightRate).toFixed() };
  const amount = Object.values(components).reduce((sum, value) => sum.plus(value), new D(0));
  return { month: input.month, currency: 'KRW', formulaVersion: 'salary-user-rates-1', rounding: 'FLOOR_ONCE_TO_WHOLE_KRW', assumptions: ['FULL_MONTHLY_BASE', 'NORMAL_RATE_REFERENCE_ONLY', 'NIGHT_RATE_ADDITIONAL_PREMIUM', 'USER_RATES_NOT_STATUTORY_PAYROLL', 'NO_DEDUCTIONS_OR_PRORATION'], hours: { normal: hours.normal.toFixed(), weekdayOvertime: hours.weekdayOvertime.toFixed(), saturday: hours.saturday.toFixed(), sunday: hours.sunday.toFixed(), night: hours.night.toFixed() }, components, rawAmountKrw: amount.toFixed(), amountKrw: amount.toFixed(0, D.ROUND_DOWN) };
}
