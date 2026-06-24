# 96. Request Hardening (size caps, field bounds, rate limit, OTLP row cap)

Front-line input hardening applied **before** auth + route handlers run, so egregiously-large or
abusive payloads are rejected cheaply. The user's directive (HS-8983): *"pre-filter likely abusive
content — too large, malformed — and validate every request before execution."* This is
defense-in-depth and **auth-independent** — it holds under both the Tier-0 shared-secret model and
the Tier-1 mTLS model (§94), and is the kind of surface the HS-8987 release-time security-review
skill re-audits each release.

Shipped across HS-8986 (the guard + rate limiter), HS-8990 (per-field schema bounds + per-route-class
body caps), and HS-8998 (OTLP per-request row cap + the chunked-body gap).

## 96.1 The request guard (`src/routes/requestGuards.ts`)

`createRequestGuards({ exposed, … })` is a Hono middleware mounted on `/api/*` + `/v1/*` in
`server.ts`, **ahead of the auth middleware**. It enforces, in order:

1. **Body-size cap (413).** Reject a request whose `Content-Length` exceeds the cap for its route
   class, before the handler buffers the body. Caps are **path-aware** (`defaultBodyCap`) so a JSON
   mutation can't ship 100 MiB — only an attachment upload should:
   - `JSON_BODY_CAP_BYTES` = **8 MiB** — ticket / settings JSON mutations (everything else).
   - `UPLOAD_BODY_CAP_BYTES` = **100 MiB** — attachment multipart (paths containing `/attachments`).
   - `OTLP_BODY_CAP_BYTES` = **16 MiB** — telemetry ingest (`/v1/*`).
   A single `maxBodyBytes` override collapses all routes to one cap (used in tests).

2. **Chunked-body gap (411) — HS-8998.** The Content-Length cap above can't pre-check a
   `Transfer-Encoding: chunked` body (no declared length), so a chunked request would slip past the
   byte cap. On an **exposed** server only, a request carrying `Transfer-Encoding: chunked` on the
   guarded routes is rejected **411 Length Required**. Legit clients (browser `fetch`, Claude Code's
   OTLP exporter, `curl` with a buffered body) all send `Content-Length`, so this only trips a
   streaming / abusive caller. **Loopback / Tier-0 is unaffected** (the trusted local case). The
   OTLP receiver additionally re-checks the *actual* bytes received post-read (§96.3) as
   defense-in-depth — that catches a spoofed / absent length on the trusted loopback path too.
   *(Caveat: HTTP/2 streams carry neither `Content-Length` nor `Transfer-Encoding`; the deployment
   is HTTP/1.1 via `@hono/node-server`, where chunked is the streaming signal.)*

3. **Rate limit (429).** Only on an **exposed** server, and only for **non-loopback** peers. Local
   dev, Claude's exporter, and the browser poll all arrive over loopback and are never throttled.
   `DEFAULT_RATE_LIMIT` = 1200 requests / minute per IP — far above any legit single-client cadence
   (the poll is ~1/s), well below a flood. Backed by `src/rateLimiter.ts`.

## 96.2 Per-field schema bounds (`src/limits.ts` + `src/routes/validation.ts`)

The body-size cap bounds the WHOLE payload; these bound **individual fields** at the zod schema,
returning **400** before the value reaches the DB — so an attacker can't balloon server memory / the
DB with a single oversized field while never tripping a real user. Each is **generous on purpose**,
far above any legitimate value:

| Constant | Value | Field |
| --- | --- | --- |
| `MAX_TITLE_CHARS` | 2,000 | ticket title (one line) |
| `MAX_DETAILS_CHARS` | 1 MiB | ticket details (a long document) |
| `MAX_NOTES_CHARS` | 1 MiB | a note body |
| `MAX_TAGS_CHARS` | 64 KiB | tags JSON |
| `MAX_CATEGORY_CHARS` | 200 | category id |
| `MAX_SEARCH_CHARS` | 10,000 | search query |
| `MAX_LABEL_CHARS` | 500 | a label |
| `MAX_BATCH_IDS` | 50,000 | ids in one batch op |
| `TICKETS_LIST_MAX_LIMIT` | 10,000 | `GET /api/tickets?limit=` |

## 96.3 OTLP per-request row cap (`OTLP_MAX_ROWS_PER_REQUEST`, HS-8998)

The 16 MiB OTLP body cap bounds **bytes**, not **row count**. A single ~15 MiB batch can carry
hundreds of thousands of tiny spans / data points — `otel_spans` row-cap pressure (§85) plus
cost/usage pollution — while staying under the byte cap. So the OTLP receiver (`src/routes/otel.ts`)
adds two row-level checks after reading the body:

- **Actual-byte re-check (413).** Before decoding, `body.byteLength` is re-checked against
  `OTLP_BODY_CAP_BYTES`. This catches a chunked / absent / understated `Content-Length` that bypassed
  the guard's pre-check (the guard 411s chunked on an *exposed* server; this primarily covers the
  trusted loopback path).
- **Per-request row cap (400).** `countOtlpRows(signalType, parsed, cap)` counts the **leaf rows** a
  payload would insert, matching the depth each writer in `otelWriters.ts` iterates — metrics → data
  points (`resourceMetrics[].scopeMetrics[].metrics[].<kind>.dataPoints[]`), logs → log records
  (`resourceLogs[].scopeLogs[].logRecords[]`), traces → spans
  (`resourceSpans[].scopeSpans[].spans[]`). Over `OTLP_MAX_ROWS_PER_REQUEST` (**25,000**) → **400**.
  OTLP treats a 4xx as **permanent**, so the exporter drops the batch — no retry storm. The cap is
  generous: the OTel BatchSpanProcessor default flush is 512 records, so 25k is ~50× a normal flush,
  well under the 100k+ a 16 MiB tiny-span flood would carry. The counter is shape-tolerant (garbage
  → 0) and **early-outs** once the running count exceeds the cap so a pathological payload can't make
  the count itself expensive.

## 96.4 What is deliberately NOT here (residual / follow-ups)

- **Per-window OTLP ingest-volume cap.** The per-request row cap bounds a single batch; a flood of
  many under-cap batches is bounded only by the §96.1 rate limiter (which is generic, not
  telemetry-specific) and the §85 retention sweep that trims `otel_spans`. A telemetry-specific
  per-window volume cap was considered and left as a future tightening.
- **True streaming abort (no buffering) on the trusted loopback path.** On an exposed server chunked
  is rejected before the body is buffered (411); on loopback a chunked body is still buffered up to
  OS limits before the §96.3 byte re-check bounds what is *decoded + persisted*. Loopback is the
  trusted Tier-0 case, so this is acceptable; a fully-streaming capped reader is a possible future
  hardening if loopback trust ever weakens.

## 96.5 Cross-references

- §67 (telemetry — the OTLP receiver + writers the row cap protects), §85 (telemetry retention /
  `otel_spans` row-cap sweep — the downstream pressure the per-request cap relieves).
- §94 (strong remote auth / mTLS — the auth model; this hardening is auth-independent and holds under
  both tiers), HS-7940 / HS-8983 (the bind / origin / OTLP-exposure gates).
- HS-8987 (the recurring release-time security-review skill that re-audits this surface).
