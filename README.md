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

Official references and their verification date are defined in `src/rules.ts`. Tests include the [MOEL worked example](https://moel.go.kr/retirementpayCal.do), calendar boundaries, ordinary-wage selection, DC partial years, invalid requests, and response caching behavior. Production launch still needs independent labor-rule review.

## Container

```sh
docker build -t e9-severance-api .
docker run --rm -p 3001:3001 -e ALLOWED_ORIGINS=https://your-web-origin.example e9-severance-api
```

Use HTTPS at the deployment boundary, set the exact browser origins, and configure proxy/IP handling for the chosen host before relying on IP rate limiting behind a proxy. No deployment service is provisioned by this repository.
