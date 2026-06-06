# 81. Announcer — Local (Ollama / OpenAI-compatible) Summarization Provider

**Status: Shipped (HS-8792, 2026-06-06).** Origin: the HS-8790 design discussion.
After Apple Foundation Models (macOS-only, on-device) and the provider
abstraction shipped, this adds a **cross-platform** free/private on-device option
so Linux, non-Copilot+ Windows, and older Macs also get one — by talking to a
**local LLM server the user already runs** rather than a per-OS native framework.

This doc is the source of truth for the local provider. It builds on
[78-announcer.md](78-announcer.md) (the Announcer + the provider-tagged model
registry, §"Multi-provider summarization"), [79-api-keys.md](79-api-keys.md) (the
Anthropic-key registry, irrelevant here — local needs no key), and
[80-announcer-live-mode.md](80-announcer-live-mode.md) (the server generator,
which the local provider serves unchanged because it runs server-side).

## 81.1 Why a local HTTP endpoint (not native per-OS)

Unlike Apple Foundation Models / Windows Phi Silica (OS-provided models), Linux
has no built-in model, so the realistic path is a local runtime the user already
runs. One integration against the **OpenAI-compatible HTTP API** covers every
common local runtime — **Ollama, LM Studio, llama.cpp's server, vLLM** — on all
three OSes, with no native compile and no code-signing. A Windows Phi-Silica
specific provider is explicitly **not** planned.

## 81.2 Model registry

`src/announcer/models.ts` (the provider-tagged registry from HS-8790) gains:

- `AnnouncerProvider` adds `'local'` (now `'anthropic' | 'apple' | 'local'`).
- `LOCAL_MODEL_ID = 'local'` — a single **pseudo-id** (like `apple-foundation`).
  The concrete model name + endpoint are NOT registry entries (they're
  user-configurable), so the registry carries one "Local model" option and the
  specifics live in the global config (§81.3).
- `ANNOUNCER_MODELS` lists the local option **second** (after Apple, both
  on-device/free), then the Anthropic models. `ANNOUNCER_MODEL_IDS` includes it
  so it's a valid persisted `announcerModel`.
- `ANNOUNCER_PRICING[LOCAL_MODEL_ID] = { 0, 0 }` — on-device → **$0**; `usage` is
  `null` so nothing lands on the §70/§71 cost dashboards.
- `providerForModel('local') === 'local'`.

## 81.3 Config

Two global keys (`GlobalConfigSchema` in `src/routes/validation.ts`; used only
when `announcerModel === 'local'`):

- `announcerLocalEndpoint?: string` — the OpenAI-compatible **base URL**. Default
  `http://localhost:11434/v1` (Ollama's port + `/v1` prefix). Trailing slashes
  are stripped on read.
- `announcerLocalModel?: string` — the concrete model name (e.g. `llama3.1`).

## 81.4 Availability probe + model detection

`src/announcer/localProvider.ts` (pure Node, global `fetch`, injectable
fetch + clock for tests):

- `isLocalProviderAvailable()` — GETs `{base}/models`; **reachable AND ≥1 model
  listed ⇒ available**. Cached for `LOCAL_PROBE_TTL_MS` (10 s) — short, unlike
  the Apple helper's session-long cache, because a local server can be
  started/stopped mid-session.
- `listLocalModels()` — the model ids from the same probe (OpenAI `/models`
  shape `{ data: [{ id }] }`), tolerant of shape drift → `[]` on failure. Feeds
  the settings dropdown.
- `runLocalSummarize(system, material, { endpoint, model })` — POSTs
  `{base}/chat/completions` with `messages: [system, user]`,
  `response_format: { type: 'json_object' }` (best-effort; ignored-by-endpoint
  is fine — see §81.5), `stream: false`. Returns `choices[0].message.content`.
  Throws on a missing model or a non-2xx response.

## 81.5 Summarization routing

`summarizeWork` (`src/announcer/summarize.ts`) routes by provider. The `local`
branch appends `LOCAL_JSON_INSTRUCTION` to the system prompt — a generic local
model has **no output-schema enforcement** (unlike Anthropic's `output_config`
or Apple's guided generation), so the exact `{"entries":[…]}` contract is spelled
out in the prompt and the tolerant `parseEntriesJson` (fence/bare-array
tolerant) validates the reply. On-device → `usage: null`.

The caller (`generateAnnouncementsOnce`) resolves `localEndpoint`/`localModel`
from the global config and passes them in; the Anthropic/Apple paths ignore them.

## 81.6 Provider gating (shared)

`prepareSummarizationProvider(model)` in `src/announcer/generate.ts` is the single
source of truth for "is this provider ready, and what credential does it need":
`anthropic` → the user's key; `apple` → the helper available; `local` → the
endpoint reachable. It returns `{ ready, apiKey, error }`. The manual
`POST /api/announcer/generate` route, the `POST /api/announcer/live` lease gate,
and the live-mode generator (`liveGenerator.ts`) all use it, so the three paths
can never diverge (this replaced the duplicated per-site apple-vs-anthropic
branching from HS-8790).

## 81.7 API + settings UI

- `GET /api/announcer/overview` adds `localAvailable` (parallel to
  `appleAvailable`) so the header **Listen** button shows (and a specific-project
  launch generates) for an enabled project with no Anthropic key.
- `GET /api/announcer/status` adds `localAvailable` + `localModels` (the detected
  model ids for the dropdown).
- Settings → Announcer: the **Summarization model** dropdown shows the "Local
  model" option only when `localAvailable`. Selecting it reveals a **local-model
  field** — an endpoint URL input + a **model dropdown populated from the detected
  models** — and hides the Anthropic key field. A stored-but-currently-absent
  model name is kept in the dropdown so it isn't silently dropped; changing the
  endpoint re-probes and repopulates. The on-device options are never the
  *automatic* default (Apple is, when present) — local is opt-in via explicit
  selection, since it requires the user to run a server.

## 81.8 Tests

- `localProvider.test.ts` — availability matrix (reachable+models / reachable+no
  models / unreachable / non-2xx), model-list parse, TTL caching, endpoint
  resolution + trailing-slash strip, `runLocalSummarize` (content extraction,
  no-model + non-2xx throws, malformed → '').
- `summarize.test.ts` — local routing (no Anthropic call/key, `usage` null,
  endpoint+model passed through, JSON instruction appended; default-endpoint
  fallback).
- `models.test.ts` — `providerForModel('local')`, $0 pricing.
- The end-to-end **settings UI** (the model dropdown against a live endpoint) is a
  manual item (`docs/manual-test-plan.md` §15) + an e2e follow-up — see below.

## 81.9 Follow-ups

- **E2E** for the local settings UI (model dropdown population + conditional
  field visibility) against a mocked `/status`/`/overview` (tracked separately).
- A future provider (e.g. a hosted OpenAI-compatible gateway) slots into the same
  `providerForModel` seam + `prepareSummarizationProvider` gate with no other
  changes.
