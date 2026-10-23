import { Type, type Static } from '@sinclair/typebox';

const DateString = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Korean calendar date, YYYY-MM-DD' });
const Money = Type.String({ pattern: '^(0|[1-9]\\d{0,14})(\\.\\d{1,6})?$', description: 'Non-negative KRW decimal string' });
const DecimalString = Type.String();
export const Method = Type.Union([Type.Literal('normal'), Type.Literal('db'), Type.Literal('dc')]);
export const Employment = Type.Object({
  startDate: DateString,
  lastWorkingDate: DateString,
  weeklyHours: Type.Number({ minimum: 0, maximum: 168 }),
  hasSpecialCircumstances: Type.Boolean({ description: 'Leave adjustments, prior settlements, scheme changes, or variable hours' }),
}, { additionalProperties: false });
export const ContextInput = Type.Object({ method: Method, employment: Employment }, { additionalProperties: false });
const Wage = Type.Object({ startDate: DateString, endDate: DateString, basePay: Money, allowances: Money }, { additionalProperties: false });
const AnnualWage = Type.Object({ year: Type.Integer({ minimum: 1900, maximum: 2100 }), wages: Money }, { additionalProperties: false });
export const CalculationInput = Type.Union([
  Type.Object({
    method: Type.Union([Type.Literal('normal'), Type.Literal('db')]), employment: Employment,
    wages: Type.Optional(Type.Array(Wage, { maxItems: 4 })),
    annualBonus: Type.Optional(Money), annualLeavePay: Type.Optional(Money),
    ordinaryDailyWage: Type.Optional(Type.Union([Money, Type.Null()])),
  }, { additionalProperties: false }),
  Type.Object({
    method: Type.Literal('dc'), employment: Employment,
    dcWages: Type.Optional(Type.Array(AnnualWage, { maxItems: 51 })),
    reportedBalance: Type.Optional(Type.Union([
      Type.Object({ amount: Money, asOf: DateString }, { additionalProperties: false }), Type.Null(),
    ])),
  }, { additionalProperties: false }),
]);
const Eligibility = Type.Object({
  status: Type.Union([Type.Literal('eligible'), Type.Literal('ineligible'), Type.Literal('review_required')]),
  reasons: Type.Array(Type.String()),
});
const Period = Type.Object({ startDate: DateString, endDate: DateString, days: Type.Integer() });
export const ContextResponse = Type.Object({
  method: Method, retirementDate: DateString, employmentDays: Type.Integer(),
  lookbackStart: DateString, lookbackDays: Type.Integer(),
  eligibility: Eligibility, wagePeriods: Type.Array(Period),
  dcPeriods: Type.Array(Type.Object({ year: Type.Integer(), startDate: DateString, endDate: DateString })),
});
export const Sources = Type.Array(Type.Object({ id: Type.String(), title: Type.String(), url: Type.String() }));
export const RulesResponse = Type.Object({
  rulesVersion: Type.String(), verifiedOn: DateString, methods: Type.Array(Method),
  currency: Type.Literal('KRW'), rounding: Type.String(), sources: Sources,
});
export const CalculationResponse = Type.Object({
  method: Method, status: Eligibility.properties.status, context: ContextResponse,
  rulesVersion: Type.String(), verifiedOn: DateString, sources: Sources,
  warnings: Type.Array(Type.String()), rounding: Type.String(),
  result: Type.Optional(Type.Union([
    Type.Object({
      kind: Type.Literal('severance'), amountKrw: DecimalString, rawAmountKrw: DecimalString,
      periodWagesKrw: DecimalString, bonusIncludedKrw: DecimalString, leaveIncludedKrw: DecimalString,
      referenceWagesKrw: DecimalString, averageDailyWageKrw: DecimalString,
      ordinaryDailyWageKrw: Type.Union([DecimalString, Type.Null()]), applicableDailyWageKrw: DecimalString,
      wageBasis: Type.Union([Type.Literal('average'), Type.Literal('ordinary')]), provisional: Type.Boolean(),
    }),
    Type.Object({
      kind: Type.Literal('dc'), requiredContributionKrw: DecimalString, rawContributionKrw: DecimalString,
      totalWagesKrw: DecimalString,
      years: Type.Array(Type.Object({ year: Type.Integer(), wagesKrw: DecimalString, contributionKrw: DecimalString })),
      reportedBalance: Type.Union([Type.Object({ amount: DecimalString, asOf: DateString }), Type.Null()]),
    }),
  ])),
});
export const ErrorResponse = Type.Object({
  code: Type.String(), message: Type.String(),
  issues: Type.Array(Type.Object({ field: Type.String(), code: Type.String() })),
});
export type ContextRequest = Static<typeof ContextInput>;
export type CalculationRequest = Static<typeof CalculationInput>;
export type CalculationContext = Static<typeof ContextResponse>;
export type CalculationOutput = Static<typeof CalculationResponse>;
