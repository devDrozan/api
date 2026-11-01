# ထွယ်ဂျီဂွမ်Caculator — API

Calculation service for the English/Burmese severance calculator. It provides Normal statutory severance, DB baseline estimates, DC required-contribution estimates, eligibility explanations, and official source metadata. Estimates are gross KRW amounts before tax. No database or account is needed.

## Development

```sh
npm ci
cp .env.example .env
npm run dev
```

Use Node.js 24. Defaults to `http://127.0.0.1:3001`. Scripts read `.env` when present. Salary payloads are never logged; responses use `Cache-Control: no-store`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP listening port |
| `HOST` | `127.0.0.1` | Listening interface; use `0.0.0.0` for device access or containers |
| `ALLOWED_ORIGINS` | Local web/Expo origins in `.env.example` | Comma-separated browser origins allowed to access the API |
| `TRUSTED_PROXIES` | Empty | Comma-separated IP addresses or CIDR ranges of reverse proxies whose forwarded client IPs Fastify may trust |

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Health check |
| GET | `/v1/rules` | Rule version, sources, and display-rounding convention |
| POST | `/v1/calculations/context` | Service duration, eligibility, calendar wage-entry periods |
| POST | `/v1/calculations` | Normal, DB, or DC calculation |

The exported [OpenAPI contract](contract/openapi.json) defines every request and response. Monetary values are decimal strings; employment dates use `YYYY-MM-DD`. `lastWorkingDate` is inclusive. The retirement date is the following day. Clients supply actual wages for the exact generated periods.

Check that the service is running and inspect the available rules:

```sh
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/v1/rules
```

Call `/v1/calculations/context` with employment details first, then use its wage-entry periods when submitting `/v1/calculations`.

## Checks and production build

```sh
npm run typecheck
npm test
npm run build
npm run contract
npm start
```

`npm run contract` exports the OpenAPI schema to `contract/openapi.json` without starting a listening HTTP server. Results include a separate `rulesVersion` identifying the calculation rules used.

## Rules and supported cases

- Normal/DB: reference-period wages plus eligible annual bonus and annual leave-pay portions; use ordinary daily wage if it is higher; multiply by 30 and service days divided by 365.
- DC: total eligible wage earnings divided by 12, with yearly details and a separately entered statement balance.
- Decimal arithmetic retains intermediate precision; only the final whole-won display is rounded down.
- Eligibility uses one calendar year of continuous service and scheduled weekly hours of at least 15 for stable schedules.
- Special adjustments and employment beginning before 2013 require review. A zero reference wage also requires review.
- Missing ordinary daily wage makes a Normal/DB result provisional. No result is returned for review-required or ineligible cases.

Calculation revision `2026.10.29.1` corrects whole-won boundary rounding by evaluating the full wage fraction before final rounding. It also validates supplied ordinary daily wages before eligibility returns. The official-source verification date is unchanged.

Official references and their verification date are defined in `src/rules.ts`. Tests include the [MOEL worked example](https://moel.go.kr/retirementpayCal.do), calendar boundaries, ordinary-wage selection, DC partial years, invalid requests, and response caching behavior. Production launch still needs independent labor-rule review.

## Container

```sh
docker build -t e9-severance-api .
docker run --rm -p 3001:3001 -e ALLOWED_ORIGINS=https://your-web-origin.example e9-severance-api
```

Use HTTPS at the deployment boundary and set the exact browser origins. When a reverse proxy fronts the API, set `TRUSTED_PROXIES` to that proxy's IP address or CIDR range so rate limits apply per client. Keep the API origin unreachable directly from the internet. Do not set `TRUSTED_PROXIES` to all addresses: an untrusted caller could then spoof forwarded IP headers and evade rate limits. No deployment service is provisioned by this repository.

## Salary estimate from work time

`POST /v1/salary-estimates` estimates gross KRW from a selected month, decimal-string pay settings, and unique daily normal/overtime/night hour records. The full basic salary covers normal weekday hours; weekday overtime and full weekend rates add pay, with an overlapping extra night premium. The normal rate is reference-only. These user-entered rates do not implement statutory payroll, deductions, or proration. Responses include categorized hours, components, formula version and final whole-won rounding. No records are stored server-side; request/response caching and payload logging remain disabled. See the exported OpenAPI contract for bounded inputs and structured errors.
