import { Decimal } from 'decimal.js';
import type { CalculationContext, CalculationOutput, CalculationRequest, ContextRequest } from './schemas.js';
import { RULES } from './rules.js';

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_DOWN });
const DAY = 86_400_000;
export class InputError extends Error {
  constructor(public issues: { field: string; code: string }[]) { super('Please check the submitted information.'); }
}
const issue = (field: string, code: string): never => { throw new InputError([{ field, code }]); };
function parseDate(value: string, field: string): Date {
  const d = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value || d.getUTCFullYear() < 1900 || d.getUTCFullYear() > 2100) issue(field, 'INVALID_DATE');
  return d;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
function minusMonths(d: Date, months: number): Date {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1));
  const maxDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d.getUTCDate(), maxDay)));
}

export function getContext(input: ContextRequest): CalculationContext {
  const start = parseDate(input.employment.startDate, 'employment.startDate');
  const last = parseDate(input.employment.lastWorkingDate, 'employment.lastWorkingDate');
  if (last < start) issue('employment.lastWorkingDate', 'DATE_ORDER');
  const retirement = plusDays(last, 1);
  const employmentDays = (retirement.getTime() - start.getTime()) / DAY;
  if (employmentDays > 366 * 50) issue('employment.lastWorkingDate', 'PERIOD_TOO_LONG');
  const lookback = minusMonths(retirement, 3);
  const reasons: string[] = [];
  let status: CalculationContext['eligibility']['status'] = 'eligible';
  if (input.employment.hasSpecialCircumstances || start.getUTCFullYear() < 2013) {
    status = 'review_required';
    reasons.push(input.employment.hasSpecialCircumstances ? 'SPECIAL_CIRCUMSTANCES' : 'HISTORICAL_EMPLOYMENT');
  } else {
    // Anniversary-based service eligibility avoids treating 365 days in a leap-year span as a full calendar year.
    const anniversary = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()));
    if (retirement < anniversary) reasons.push('SERVICE_UNDER_ONE_YEAR');
    if (input.employment.weeklyHours < 15) reasons.push('HOURS_UNDER_15');
    if (reasons.length) status = 'ineligible';
  }
  const wagePeriods: CalculationContext['wagePeriods'] = [];
  for (let cursor = lookback; cursor < retirement;) {
    const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const endExclusive = nextMonth < retirement ? nextMonth : retirement;
    wagePeriods.push({ startDate: iso(cursor), endDate: iso(plusDays(endExclusive, -1)), days: (endExclusive.getTime() - cursor.getTime()) / DAY });
    cursor = endExclusive;
  }
  const dcPeriods: CalculationContext['dcPeriods'] = [];
  for (let year = start.getUTCFullYear(); year <= last.getUTCFullYear(); year++) {
    dcPeriods.push({ year, startDate: year === start.getUTCFullYear() ? iso(start) : `${year}-01-01`, endDate: year === last.getUTCFullYear() ? iso(last) : `${year}-12-31` });
  }
  return { method: input.method, retirementDate: iso(retirement), employmentDays, lookbackStart: iso(lookback), lookbackDays: (retirement.getTime() - lookback.getTime()) / DAY, eligibility: { status, reasons }, wagePeriods, dcPeriods };
}

export function calculate(input: CalculationRequest): CalculationOutput {
  const context = getContext(input);
  const ordinary = input.method === 'dc' || input.ordinaryDailyWage == null ? null : new D(input.ordinaryDailyWage);
  if (ordinary !== null && ordinary.lessThanOrEqualTo(0)) issue('ordinaryDailyWage', 'POSITIVE_ORDINARY_WAGE');
  if (input.method === 'dc') {
    if (input.reportedBalance) parseDate(input.reportedBalance.asOf, 'reportedBalance.asOf');
  } else {
    input.wages?.forEach((row, index) => {
      parseDate(row.startDate, `wages.${index}.startDate`);
      parseDate(row.endDate, `wages.${index}.endDate`);
    });
  }
  const output: CalculationOutput = {
    method: input.method, status: context.eligibility.status, context,
    rulesVersion: RULES.rulesVersion, verifiedOn: RULES.verifiedOn, sources: RULES.sources,
    rounding: RULES.rounding, warnings: [],
  };
  if (output.status !== 'eligible') return output;
  if (input.method === 'dc') {
    const rows = input.dcWages ?? [];
    if (rows.length !== context.dcPeriods.length || new Set(rows.map(r => r.year)).size !== rows.length || context.dcPeriods.some(p => !rows.some(r => r.year === p.year))) issue('dcWages', 'WAGE_YEARS_MISMATCH');
    const total = rows.reduce((sum, r) => sum.plus(r.wages), new D(0));
    if (total.isZero()) { output.status = 'review_required'; output.warnings.push('ZERO_WAGES'); return output; }
    const required = total.div(12);
    output.result = {
      kind: 'dc', requiredContributionKrw: required.toFixed(0, D.ROUND_DOWN), rawContributionKrw: required.toFixed(12),
      totalWagesKrw: total.toFixed(),
      years: [...rows].sort((a, b) => a.year - b.year).map(r => ({ year: r.year, wagesKrw: r.wages, contributionKrw: new D(r.wages).div(12).toFixed(12) })),
      reportedBalance: input.reportedBalance ?? null,
    };
    output.warnings.push('DC_BALANCE_SEPARATE');
    return output;
  }
  const rows = input.wages ?? [];
  if (rows.length !== context.wagePeriods.length || new Set(rows.map(r => `${r.startDate}:${r.endDate}`)).size !== rows.length || context.wagePeriods.some(p => !rows.some(r => r.startDate === p.startDate && r.endDate === p.endDate))) issue('wages', 'WAGE_PERIODS_MISMATCH');
  const wages = rows.reduce((sum, r) => sum.plus(r.basePay).plus(r.allowances), new D(0));
  const bonus = new D(input.annualBonus ?? '0').times(3).div(12);
  const leave = new D(input.annualLeavePay ?? '0').times(3).div(12);
  const reference = wages.plus(bonus).plus(leave);
  if (reference.isZero()) { output.status = 'review_required'; output.warnings.push('ZERO_WAGES'); return output; }
  const average = reference.div(context.lookbackDays);
  const useOrdinary = ordinary !== null && ordinary.times(context.lookbackDays).greaterThan(reference);
  const daily = useOrdinary ? ordinary! : average;
  // Keep the average-wage numerator exact until the final division. Reusing
  // the recurring daily average can put an exact whole-won result below its boundary.
  const amount = useOrdinary
    ? ordinary!.times(30).times(context.employmentDays).div(365)
    : reference.times(30).times(context.employmentDays).div(new D(context.lookbackDays).times(365));
  output.result = {
    kind: 'severance', amountKrw: amount.toFixed(0, D.ROUND_DOWN), rawAmountKrw: amount.toFixed(12),
    periodWagesKrw: wages.toFixed(), bonusIncludedKrw: bonus.toFixed(), leaveIncludedKrw: leave.toFixed(), referenceWagesKrw: reference.toFixed(),
    averageDailyWageKrw: average.toFixed(12), ordinaryDailyWageKrw: ordinary?.toFixed() ?? null,
    applicableDailyWageKrw: daily.toFixed(12), wageBasis: useOrdinary ? 'ordinary' : 'average', provisional: ordinary === null,
  };
  if (ordinary === null) output.warnings.push('ORDINARY_WAGE_UNKNOWN');
  if (input.method === 'db') output.warnings.push('DB_BASELINE_ONLY');
  return output;
}
