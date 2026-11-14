# CBM experimental backend test results

Live check: **14 November 2026, 23:28:38 Asia/Seoul** (`2026-11-14T14:28:38.743Z`). The published CBM rate date was **13 November 2026**, not the retrieval date.

| Source / rate | Original MMK per 100 KRW | Normalized MMK per 1 KRW | Comparison |
| --- | --- | --- | --- |
| Official website, market-based indicative cross rate | 273.88 | 2.7388 | Exact normalization; multiplying by 100 reproduces the displayed value |
| Official website, reference-based column | 157.14 | 1.5714 | Matches reference API |
| CBM reference API, KRW | 157.14 | 1.5714 | Same source date and reference value as website |

Sources: <https://forex.cbm.gov.mm/index.php/fxrate> and <https://forex.cbm.gov.mm/api/latest>. Both direct backend requests returned HTTP 200 with the expected HTML/JSON content type. The JSON supplied timestamp `1794556800`; it is preserved as source date metadata, not claimed as an exact publication time. Its KRW unit is established by the matching website row, because the JSON itself has no units field.

The first probe call fetched the two sources. The second returned `HIT`; total upstream requests remained **2**, and retrieval time stayed unchanged. Cache validity ended at `2026-11-14T14:43:38.743Z`. Market and reference rates were never substituted for one another.

Focused automated tests: **32 passed**. Experimental TypeScript check with `--noEmit`: **passed**. Full API regression suite: **131 tests passed across 4 files** (including the 32 focused CBM tests). Tests cover precise normalization, missing/duplicate rows, changed units/columns, malformed values/dates/JSON, publication comparison mismatches, Myanmar midnight/expiry, shared requests, cache expiry/mutation isolation, backoff, upstream HTTP/429, content type, body size and stalled-body timeout. Live results are observations, not assertions pinned to a future rate.

Only isolated files in `api/experiments/cbm/` were added for this task. Existing server routes, provider selection, contracts, UI and dependencies were not modified. No build, commit, push or deployment was performed. This is a technical experiment, not production provider activation or permission to redistribute CBM data commercially.

## Production/mobile integration follow-up — 14 November 2026

The experiment implementation was promoted into `api/src/cbm.ts`. Dedicated CBM GET/conversion endpoints now serve mobile Official Rate; the experiment runner re-exports those functions. Earlier “test only” statements above describe the original run, before the separately requested integration.

Live HTTP-handler verification (Fastify injection with real CBM HTTPS retrieval): provider Central Bank of Myanmar, publication 13 November 2026, original market 273.88 MMK per 100 KRW, normalized 2.7388, comparison reference 1.5714. Synthetic 100000 KRW → 273880.00 MMK → 100000 KRW. Hundi retained 100000 × 4400 / 1350 → 325925.92 MMK and its existing version. Conversion returned no-store and reused the original cached retrieval timestamp.

API: **146 tests passed** and TypeScript no-emit passed. Mobile: **169 tests across 19 suites passed**, TypeScript and Expo lint passed. Mobile CBM/English/Burmese source display, direct Home/Services/search navigation, historical redirect, errors, late-response guards and Hundi-outage behavior are covered. Prior mobile contract paths remain byte-equivalent as JSON objects; only two CBM paths were added. API/mobile pinned artifacts match. No UI arithmetic, app build, commit, push, store upload or deployment was performed. Native visual/device verification remains separate.
