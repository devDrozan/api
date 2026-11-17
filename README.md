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
| GET | `/v1/exchange-rates/krw-mmk` | Official KRW/MMK reference metadata |
| POST | `/v1/currency-conversions` | Official-rate KRW ↔ MMK conversion |
| POST | `/v1/currency-conversions/hundi` | User-rate (hundi) KRW ↔ MMK conversion |

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

## KRW ↔ MMK conversion

Two options are supported in both directions:

- **Legacy Korean reference** — `GET /v1/exchange-rates/krw-mmk` returns reference metadata and `?refresh=true` requests a quota-aware refresh. `POST /v1/currency-conversions` accepts only `from`, `to`, and decimal-string `amount`; the server selects the quote.
- **Hundi Rate** — `POST /v1/currency-conversions/hundi` accepts `from`, `to`, `amount`, `mmkPerUsd`, and `usdPerKrw`. It applies **KRW → MMK = KRW × MMK/USD ÷ USD/KRW** and **MMK → KRW = MMK × USD/KRW ÷ MMK/USD** using the entered decimal rates.

Calculation uses decimal.js with 80 significant digits, the original quoted MMK unit or the exact user rates, and one final floor to whole KRW or two decimal places in MMK. Hundi rates must be positive decimals with at most six whole and four fractional digits; invalid input returns `INVALID_HUNDI_RATE` or `INVALID_USD_KRW_RATE` with the field. User amounts and user rates never go to the rate supplier. No database/history is created; all HTTP responses remain `no-store`.

### Legacy Korean reference sources

The legacy reference option uses Korean publications, tried in this order. The result always names the institution that actually supplied it, with its own publication metadata; sources are never averaged or relabelled.

1. **KB Kookmin Bank** — the public 환율조회 (전체통화) table at `https://obank.kbstar.com/quics?page=C101423`. The API reads the MMK `매매기준율` (KRW per 1 kyat) and the page's rate-registration stamp and round, so the quote carries second-level publication time in KST. KB publishes MMK to two decimal places, so the applied rate is exactly the published figure (for example `0.64` KRW per kyat).
2. **Licensed normalized feed** — optional, only when configured and approved. This is the path for Hana Open API or IBK Open API once client credentials are issued; an operator-owned adapter maps the licensed response to the documented shape below.
3. **Korea Money Brokerage Corp.** — the public official interbank table at `https://www.kmbco.com/kor/rate/financial_rate.do`. The API reads the MMK `대원화환율` (KRW per 1 kyat) and the `기준일자`; the page publishes no time, so the result is date-only precision.

Set `EXCHANGE_RATE_PROVIDER=none` to disable official conversion and return `503 RATE_UNAVAILABLE`; clients then show an unavailable/retry state while hundi conversion remains usable.

| Variable | Purpose |
| --- | --- |
| `EXCHANGE_RATE_PROVIDER` | `auto` (default: KB → licensed feed when configured → KMB), `kb`, `kmb`, `hana` (licensed feed only), or `none` |
| `EXCHANGE_RATE_ACCESS_APPROVED` | Exact `true` enables the licensed normalized feed; default `false` |
| `EXCHANGE_RATE_FEED_PROVIDER` | Licensed feed attribution: `hana` (default), `kb`, or `kmb` |
| `EXCHANGE_RATE_FEED_URL` | Trusted HTTPS normalized feed endpoint, without userinfo, query, fragment, or redirects |
| `EXCHANGE_RATE_FEED_TOKEN` | Optional server-only Bearer credential; never put it into a client environment variable |

The licensed feed must return `application/json` and this shape (values below are a **synthetic example**, never a production fallback):

```json
{
  "provider": "hana",
  "rateType": "REFERENCE",
  "publicationDate": "2026-11-08",
  "publishedAt": null,
  "krwPerQuotedUnit": "0.5",
  "mmkUnit": "1"
}
```

`krwPerQuotedUnit` is Q KRW per U MMK. U is any positive decimal quoted unit; Q must be positive, at most 15 integer and 18 fractional digits. `publishedAt` is optional/null for date-only data; otherwise use seconds precision with an explicit timezone and a date matching the publication's Korean date. The configured provider must match the feed. Institution name and official source URL are set by the API, never accepted as arbitrary links from the feed. An adapter must map the institutional **reference** column and preserve published precision; it must not substitute a cash/transfer price or mix institutions/dates.

A source row is rejected unless the MMK reference rate is a positive decimal in a plausible `0.05`–`5` KRW-per-kyat range and the controller's publication stamp is present and valid. A missing MMK row, a zero or implausible rate, a changed layout, or a malformed/future stamp is an invalid/unavailable rate, never a free conversion.

Source reads are server-side only, with a fixed browser identity, a 10-second header/body timeout, redirects rejected, and bounded bodies (64 KiB for JSON feeds, 512 KiB for KB, 256 KiB for KMB). Valid quotes are reused for up to 15 minutes. Manual refreshes/upstream attempts are limited to once a minute per source and concurrent requests share a retrieval. Before enabling a source, confirm this cadence satisfies its terms; use an appropriately controlled adapter if stricter limits apply. No periodic background polling occurs. A failed refresh may retain only an unexpired cached quote within that cache TTL and never changes its retrieval/publication timestamps. When the primary cannot serve a fresh valid quote, the next configured source is tried; if every source fails, the API returns `RATE_UNAVAILABLE` (or `RATE_EXPIRED` when all reached data is stale).

Rates dated today in KST are `PUBLISHED_TODAY`; 1–3 calendar days old are `PREVIOUS_PUBLISHED_RATE`; older rates are rejected as `RATE_EXPIRED`, including long holidays. Source publication time and retrieval time remain distinct. The API validates the pair/amount before loading a rate and returns structured currency errors. Reference previews are rounded to 12 decimal places; conversion uses the original Q/U values, never those previews. A result below display precision is explicitly flagged.

Run `npm test` for synthetic precision, units, KST/expiry, KB/KMB parsing and failover, licensed-feed validation, cache behavior, hundi formulas and rate validation, HTTP contracts, and existing salary/severance regression checks. Export the API contract with `npm run contract`; client copies are independent pinned artifacts.

### Mobile Official Rate — CBM market-based rate

Mobile Official Rate now calls `GET /v1/exchange-rates/krw-mmk/cbm` (`?refresh=true` supported) and `POST /v1/currency-conversions/cbm` with the usual `from`, `to`, `amount` body. These additive endpoints leave the legacy reference contracts and `/v1/currency-conversions/hundi` unchanged. No additional credential or environment variable is required; `EXCHANGE_RATE_PROVIDER` continues to configure only the legacy Korean reference endpoints.

`src/cbm.ts` owns the promoted CBM parser, cache and pure calculation. It retrieves the fixed official CBM website plus Reference Rate API, verifies their date and reference value, and uses only the market-based KRW cross rate for conversion. For R MMK per 100 KRW: KRW → MMK is amount × R / 100; reverse is amount × 100 / R. Values use decimal.js at 80-digit precision and floor once to 2 decimal MMK / whole KRW. Original R, normalized per-1 quote and reference comparison remain separate in the response, which identifies provider `cbm`, type `MARKET_TRADING`, timezone `Asia/Yangon`, and calculation version `krw-mmk-cbm-market-1`.

Dates are classified/expired at Myanmar midnight: today / previous 1–3 days / expired over three days. API timestamp is not invented as a publication instant. Only public rate snapshots are cached for 15 minutes in memory, concurrent reads share a fetch, attempts are spaced at least 60 seconds, longer numeric Retry-After is respected up to an hour, and manual refresh obeys the interval. Failed expired-cache retrieval does not return stale data. Fetches use fixed official HTTPS URLs, no redirects, 10-second whole-body deadlines and HTML 256 KiB / JSON 64 KiB limits. Invalid rows, units, dates, values and cross-source mismatches return translated structured errors. No financial input is sent to CBM, logged or cached.

Run `npm test` for production CBM calculation/HTTP/cache and Hundi regressions. The original `node --import tsx experiments/cbm/run-cbm.ts` live probe still works through the production implementation; its historical test results are not a current rate guarantee. Technical availability is not a statement of commercial source/reuse permission. API hosting and native store release remain separate operations.

## Verify an online deployment

Run `API_BASE_URL=https://YOUR-ACTUAL-API-ORIGIN npm run smoke:deployed` after deployment, substituting the actual assigned HTTPS origin. This verifies health, context, severance, salary and Hundi with public synthetic examples, checks JSON/no-store responses, and never prints financial payloads. Only health requests retry while a test host wakes (up to 90 seconds); financial POSTs are not retried automatically. For local verification only, run `API_BASE_URL=http://127.0.0.1:3001 npm run smoke:deployed -- --local`. Verify CBM separately because source availability/freshness is independent of core calculations.

Before enabling user submissions, verify the hosting provider, region, infrastructure request logging and retention. Application financial payload logging remains disabled; this does not establish provider log practices.

### Render free service for closed testing

`render.yaml` defines one free Docker web service in Singapore, without a database/disk or licensed-feed credentials. Deploy the **API repository** (`devDrozan/api`) from `codex/v1-ui-redesign`; its Dockerfile binds the provider-assigned port on `0.0.0.0`, and Render checks `/health`. Automatic redeployment is off. A native mobile client does not need a browser CORS origin. Forwarded IP trust remains disabled until provider proxy ranges have been verified, so rate limits may be shared conservatively across clients.

Use the actual HTTPS origin assigned by Render, never a guessed service URL. The free service can sleep after 15 minutes and take about a minute to wake; it is for testing, not production. Run the deployment smoke check, inspect CBM availability, and verify provider logs/retention before enabling the mobile connection. Set both `EXPO_PUBLIC_API_BASE_URL` (actual origin) and `EXPO_PUBLIC_API_WARMUP=true` in the Expo production environment, then create a new AAB. The latter makes public health checks wait for the sleeping test server before financial inputs are submitted. Existing local records are unaffected.

### Active closed-test service

The verified HTTPS origin is `https://e9-mate-calculation-api.onrender.com` (Render Free, Singapore, deployed API commit `27b5949`). Health, context, severance, salary, Hundi and CBM conversion checks passed with synthetic inputs on 16 November 2026. Automatic deployment is off. The local `render.yaml` is a reproducible configuration template; this service was created from the already-published API repository through Render’s dashboard. Its browser CORS/proxy settings currently use source defaults.

## Public mobile remote configuration

`GET /v1/mobile-config` returns schema version 1 presentation data. It uses the existing Render service, with no database, paid service, account, admin endpoint, or new credentials. Existing CORS, rate limits, security headers, logging exclusions and financial `no-store` behavior remain unchanged.

Set optional `REMOTE_CONFIG_JSON` to a complete JSON object (at most 32 KiB). `config/mobile-config.example.json` is an editable example, **not active configuration**. Minify an edited file for copying into Render with `node -e "console.log(JSON.stringify(require('./config/mobile-config.example.json')))"`. Validate locally by starting this API with the value and inspecting `/v1/mobile-config`; `revision` identifies the loaded version. Unknown keys, wrong types, duplicate IDs, unsupported versions, or malformed/oversized values cause the entire server setting to fall back to `revision: bundled-v1`. The value is read once at process startup. Do not put secrets or personal data in it.

Supported fields:

- `theme.light` / `theme.dark`: optional semantic colors in `#RRGGBB`. The original `primary`, `onPrimary`, `brandBackground`, `brandText` fields remain supported. Additional optional keys cover `background`, `surface`, `surfaceSubtle`, `text`, `muted`, `border`, `divider`, `accent`, `onAccent`, `secondary`, `secondaryBorder`, `selected`, `selectedBorder`, `link`, `placeholder`, `error`, `errorBackground`, `errorBorder`, `resultBackground`, `resultText`, `resultMuted`, `resultWarning`, `switchOn`, and `switchOff`. Missing values use the bundled blue/yellow palette. Mobile validates text across every applicable surface, button/accent/brand/result/error pairs and control boundaries; an unsafe combination restores the entire bundled palette for that appearance. The editable example includes valid complete light/dark palettes.
- `carousel`: up to 8 bilingual items; `[]` preserves the existing bundled carousel. Each item needs a unique lowercase/hyphen `id`, `label`, `title`, `body`, and `action` objects with `en` and `my`, a dark `color`, `art` (`calculator`, `coins`, `insurance`), and one bundled route (`/severance`, `/severance/guide`, `/insurance`). No remote code, HTML, images, or external URLs are accepted. Mobile replaces low-contrast slide backgrounds with its safe default.
- `notices`: up to 20 plain-text items with a unique `id`, bilingual `title` and `body`. `[]` clears notices.
- `features`: `carouselVisible`, `carouselAutoplay`, `carouselIntervalMs` (4000–30000), `noticesVisible`. These affect presentation only; every existing service remains available. AdMob, consent, calculations, API origins and security settings cannot be controlled here.

On Render Free, update the environment value and restart/deploy the **existing** service only after owner approval. This does not require an Android rebuild or EAS update once the new app is installed. Restore the previous value to roll back; clearing it restores bundled defaults. Sleeping Render instances can delay refresh; the mobile client keeps valid cached settings (up to seven days), then uses bundled defaults, and retries on a later foreground visit after an hour. There is no keepalive or polling service. Source changes still need a separately approved backend deployment. No deployment was performed by this setup.
