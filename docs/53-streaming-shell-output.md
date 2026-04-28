# 53. Streaming shell-command output (HS-7981 design)

**Status: design only.** Investigation of whether/how to stream `child_process.spawn` output for custom shell commands so command rows in the sidebar (and the Commands Log entry) update incrementally instead of jumping from "running" to "done" with all output appearing at the end.

## §53.1 Today's behaviour

- User clicks a custom shell command in `commandSidebar.tsx`. The client `POST /api/shell/exec` returns the new log entry id.
- `src/routes/shell.ts` spawns the child via `child_process.spawn`. Stdout/stderr accumulate into a single `output` string; `child.on('close')` writes the FINAL output as the log entry's `detail` and calls `notifyChange()`.
- The client runs `setInterval(..., 2000)` polling `/api/shell/running` to detect completion.
- The Commands Log panel renders the log entry with the full output ONLY after completion.

So during a long-running command (e.g. a 60 s test run), the user sees a busy spinner with no output for 60 s, then the result lands at once.

## §53.2 What the user wants

> "can we stream received shell output when running custom shell commands so that item rows can update more dynamically as output is received?"

Two surfaces want updates:
1. **Sidebar row** — currently shows a static "running" treatment. Could surface the most recent line, an animated dot count, or a percentage if the output looks parsable (e.g. progress percentages from `pip install`).
2. **Commands Log entry** — could render the partial output as the process emits it, so a user opening the entry mid-run sees what's accumulated so far.

## §53.3 Options surveyed

### Option A — Periodic polling of partial output

Server keeps the in-progress output buffered in memory keyed on log id. New endpoint `GET /api/shell/output?id=N&offset=O` returns `{output, complete}` with `output` being the slice past `offset`.

- **Pros:** simplest. No protocol changes. Reuses HTTP. Easy to add to existing 2 s `setInterval` poll.
- **Cons:** still polling; latency is bounded below by interval length. Doesn't address tape-out granularity (lines arrive in 2 s chunks, not as they're emitted).
- **Effort:** ~1 day. Add buffer Map in `shell.ts`, new endpoint, wire client polls to fetch + append.

### Option B — Server-Sent Events (SSE) per-command stream

`GET /api/shell/output-stream?id=N` opens an SSE connection that emits `data: <chunk>` events as the child emits, terminated by `event: done` on close.

- **Pros:** true real-time stream; pushes data the moment it arrives. SSE works in browsers without lib changes; easier than WebSocket.
- **Cons:** N concurrent SSE connections per command run (one per browser tab); needs reconnection logic if the server restarts mid-command; doesn't compose with the existing long-poll model.
- **Effort:** ~2 days. Hono SSE helper + buffer for late subscribers + cleanup on completion + client `EventSource` wiring.

### Option C — WebSocket per-command stream

Same as Option B but over WebSocket. The PTY infrastructure (`src/terminals/pty.ts`) already does WebSocket streaming, so this would reuse that pattern.

- **Pros:** consistent with terminal streaming; bidirectional (could stream `stdin` if we ever add an interactive command runner).
- **Cons:** more complex than SSE for a one-way stream; WebSocket lifecycle on top of the long-poll feels like overkill for "command output trickle".
- **Effort:** ~3 days. New WS route + buffer + client wiring + tests.

### Option D — Piggyback on the existing `/api/poll` long-poll

Add a `partialOutput: { [logId]: { offset, length } }` map to the poll response. Client tracks per-id offsets and fetches deltas via Option A's buffer endpoint when offsets advance.

- **Pros:** no new connection model.
- **Cons:** requires bumping the cheap-version on every chunk → flickers everything else (we just fixed this in HS-7972). Even with the new `dataVersion` split, the cheap-`changeVersion` would still bump 10 Hz during a chatty command, waking every poll waiter for nothing they care about. Goes against the §HS-7972 architectural direction.
- **Effort:** rejected.

### Option E — Coalesce and update the Commands Log entry's `detail` field via `updateLogEntry`

Server periodically (every 1 s during the run) calls `updateLogEntry(logId, { detail: combinedDetail })` so a client polling `/command-log` sees the partial. The 1 s coalescing keeps DB write rate bounded.

- **Pros:** no new endpoints; the Commands Log panel already polls/refetches log entries.
- **Cons:** the sidebar row doesn't read from log entries today; would need a separate fetch path. Also writes to PGLite at 1 Hz per running command which is wasteful when nobody's looking at the panel.
- **Effort:** ~1 day for the log-entry path; sidebar still needs Option A or B.

## §53.4 Verdict — recommended path

**Option A (polling) for v1**, **Option B (SSE) deferred** until users hit Option A's latency floor.

Reasoning:
- The user's concrete pain is "no output for 60 s" → "output lands all at once". A 1–2 s poll interval lands chunks every 1–2 s, which is a 30–60× improvement.
- SSE solves "millisecond-level streaming" which is overkill for a command-output panel a user glances at occasionally.
- Option A composes with the existing `/shell/running` poll — extend that endpoint to return `{ ids: [...], outputs: { [id]: { offset, partial } } }` so one HTTP round-trip drives both completion detection and partial output, no new endpoint surface.
- If a user runs a command emitting megabytes (e.g. a noisy build), Option A degrades gracefully — the buffer slice is bounded by polling cadence × emission rate. Cap the in-memory buffer per command at e.g. 4 MB and replace the head with `[output truncated]` so no individual command can OOM the server.

## §53.5 Concrete plan (when picked up)

### Phase 1 — Server-side partial-output buffer

- `src/routes/shell.ts` — add `const partialOutputs = new Map<number, string>()` keyed on log id. The existing `child.stdout.on('data', d => output += d.toString())` chain also writes to `partialOutputs.set(id, output)`.
- On `child.on('close')`, after the final `updateLogEntry` write, `partialOutputs.delete(id)`.
- Bound buffer size: `if (partialOutputs.get(id).length > 4 * 1024 * 1024) { /* truncate head */ }`.

### Phase 2 — Combined running + output endpoint

- `GET /api/shell/running` already returns `{ ids: number[] }`. Extend to `{ ids, outputs: Record<number, string> }` where `outputs[id]` is the COMPLETE current partial buffer (client trims by offset). Backward-compatible: clients ignoring the new field still work.
- Or, less expensive: `GET /api/shell/output?ids=1,2,3&offsets=100,0,500` returns `{ outputs: { '1': { partial: 'xyz', total_length: 150 }, ... } }`. Client tracks offsets and only fetches deltas. More complex but cheaper for big outputs.

### Phase 3 — Client wiring

- `commandSidebar.tsx::startShellPoll` extended to read `outputs` and dispatch a CustomEvent `hotsheet:shell-partial-output` with `{ id, partial }`.
- Sidebar row — subscribe to the event for its `runningLogId` and render the last 1–2 lines of `partial` as a faded inline preview below the command name.
- Commands Log entry — when the log panel is open AND the entry is selected, subscribe to the same event and append to the rendered detail in-place (preserving scroll position; auto-scroll only when the user is already pinned to the bottom).

### Phase 4 — Settings + opt-out

- New file-setting `shell_streaming_enabled: boolean` (default `true`). Settings → Commands page — toggle.
- When disabled: server still buffers (cheap), client just doesn't render partials. Useful if a user finds the trickle distracting.

## §53.6 Tests

Phase 1: server-side buffer test — spawn a fast-emitting child (`yes | head -c 10000`), assert `partialOutputs.get(id).length > 0` mid-run, deletion on close.

Phase 2: integration test — `POST /api/shell/exec` for a sleep-then-echo command, `GET /api/shell/running` returns `outputs` containing partial chunks before completion.

Phase 3: e2e — run a custom command emitting `Stage 1\nStage 2\nStage 3\n` over 3 s, assert the sidebar row's preview text updates from `Stage 1` → `Stage 2` → `Stage 3` over the run.

## §53.7 Out of scope

- **Streaming over PTY-style channels** — that's what the embedded terminal already does. Custom shell commands aren't interactive (no stdin), so spawn-with-streamed-output is enough.
- **Coloured ANSI rendering** in the sidebar preview — strip with `stripAnsi` before display. The full Commands Log entry can keep colour (xterm.js / Anser-like rendering is a separate ticket if requested).
- **Cross-session resume** — if the user reloads mid-command, the partial buffer is lost. The completed log entry is still written on `child.close`. Acceptable for v1.

## §53.8 Open questions

1. Should the sidebar row render the entire partial (limited to the most recent N lines for height), or just a count like "3 lines emitted"?
2. Should the Commands Log entry auto-scroll to the bottom when partial chunks arrive, or only scroll when the user is already at the bottom (Terminal.app-style "pin to bottom unless I've scrolled up")?
3. Should `shell_streaming_enabled` default `true` or `false`? Streaming is a behaviour change — `true` means existing users get it implicitly; `false` is more conservative but invisible.

Recommend default-on with a toast on first use ("Shell command output now streams as it arrives — Settings → Commands to disable") so the change is discoverable but reversible.
