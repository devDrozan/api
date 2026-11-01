export const RULES = {
  rulesVersion: '2026.10.29.1',
  verifiedOn: '2026-10-24',
  methods: ['normal', 'db', 'dc'] as const,
  currency: 'KRW' as const,
  rounding: 'ROUND_DOWN_FINAL_KRW',
  sources: [
    { id: 'moel-calculator', title: 'MOEL severance calculator and worked example', url: 'https://moel.go.kr/retirementpayCal.do' },
    { id: 'moel-eligibility', title: 'MOEL retirement benefit eligibility guidance', url: 'https://www.moel.go.kr/minwon/fastcounsel/fastcounselView.do?inetDcssMngId=202302031324407911000' },
    { id: 'moel-pensions', title: 'MOEL DB and DC retirement pension guidance', url: 'https://moel.go.kr/retirementpay.do' },
    { id: 'eps-insurance', title: 'EPS departure guarantee insurance information', url: 'https://www.eps.go.kr/eo/EmployPerSystem.eo?tabGb=06' },
  ],
};
