# CBM live backend probe

The original experiment has been promoted to `src/cbm.ts` for the mobile Official Rate endpoints. This directory retains the live diagnostic runner, original parser/cache regression tests and historical results; `cbm-rates.ts` re-exports production functions rather than duplicating parsing. Running this probe alone does not build, deploy or change the UI.

Run from the API directory (Node 24, existing dependencies):

```sh
npm test -- experiments/cbm/cbm-rates.test.ts
node --import tsx experiments/cbm/run-cbm.ts
```

The second command makes two bounded backend GET requests, compares matching website/API reference publications, and requests the combined snapshot again to verify a cache hit without another upstream request. It sends no customer amounts or credentials. It does not build or push anything.

Sources: [CBM official table](https://forex.cbm.gov.mm/index.php/fxrate), [reference JSON](https://forex.cbm.gov.mm/api/latest), [CBM API documentation](https://forex.cbm.gov.mm/index.php/api).

The KRW row uses **100 KRW**. Divide the original decimal MMK quotation by **100**, using decimal.js. Preserve market-based and reference-based values separately. The KRW cross-table headings are “Indicative Cross Exchange Rates for Account Transactions”; classification follows the corresponding reference/market columns. It is not an executable transfer quote. The reference API has no Market Trading Rate field or unit metadata; its KRW reference unit is established by the matching website row. A date or reference-value mismatch fails explicitly rather than silently combining publications. API timestamp is source date metadata, not a verified publication instant.

Public combined snapshots are reusable in backend process memory for 15 minutes; concurrent requests share a single retrieval. No stale snapshot is returned after cache expiry or on an upstream/validation failure. Attempts are spaced by at least 60 seconds, with longer numeric Retry-After (up to an hour) honored. Retrieval timestamps never advance on cache hits. Publication age is checked in Myanmar time; future dates and dates over three calendar days old are rejected as a conservative experimental freshness limit, not an asserted CBM service guarantee.

Each request has a whole-operation 10-second deadline (including body), no redirects, content-type/size limits (HTML 256 KiB, JSON 64 KiB), and structured errors for timeout, network, HTTP/rate-limit, malformed/changed/duplicate/missing data, stale/future dates, mismatched publications and values. There is no alternate-source fallback or substitution of reference for market data. Public-page retrieval for this local experiment does not establish commercial redistribution rights or production suitability.
