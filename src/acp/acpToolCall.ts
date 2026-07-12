// HS-9330 item 2 — map an ACP `session/request_permission` `toolCall` onto the display
// fields the §47 overlay shows (`tool_name` / `description` / `input_preview`).
//
// The `toolCall` shape was captured from a LIVE OpenCode turn (docs/114 §114.11) — an
// `edit` request looks like:
//   { toolCallId, title: "<file path>", kind: "edit", status: "pending",
//     locations: [{ path }], rawInput: { filepath, diff }, content: [{ type: "diff", … }] }
// Pure + defensive (every field optional / possibly the wrong type — a newer agent or a
// different tool `kind` must still render something), so it's unit-testable against the
// captured fixture with no live agent.

/** The overlay's display fields, derived from an ACP `toolCall`. */
export interface AcpToolCallDisplay {
  /** The tool category (`kind`), used as the overlay's tool chip (e.g. `edit`, `bash`). */
  tool_name: string;
  /** A one-line title — the agent's `title` (for `edit`, the file path). */
  description: string;
  /** A readable body: the diff for an `edit`, else the raw tool input as JSON. */
  input_preview: string;
}

/** Max preview length — matches the Claude path's ~2000-char `input_preview` cap so the
 *  overlay's `<pre>` / live-checkout heuristics behave identically across transports. */
const PREVIEW_CAP = 2000;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function extractToolCallDisplay(toolCall: unknown): AcpToolCallDisplay {
  const tc = asRecord(toolCall) ?? {};
  const kind = typeof tc.kind === 'string' && tc.kind !== '' ? tc.kind : 'tool';
  const title = typeof tc.title === 'string' ? tc.title : '';

  // Body: an `edit`'s `rawInput.diff` reads best; else the whole `rawInput` as JSON; else
  // fall back to the rendered `content` (some tools carry only that).
  let inputPreview = '';
  const rawInput = asRecord(tc.rawInput);
  if (rawInput !== null) {
    if (typeof rawInput.diff === 'string' && rawInput.diff !== '') {
      inputPreview = rawInput.diff;
    } else {
      inputPreview = safeJson(rawInput);
    }
  } else if (tc.content !== undefined) {
    inputPreview = safeJson(tc.content);
  }

  return {
    tool_name: kind,
    description: title !== '' ? title : kind,
    input_preview: inputPreview.slice(0, PREVIEW_CAP),
  };
}

/** JSON.stringify that can't throw (circular refs / BigInt) — falls back to String().
 *  (`JSON.stringify` is typed `string` but returns `undefined` for undefined/functions.) */
function safeJson(v: unknown): string {
  try {
    const s: string | undefined = JSON.stringify(v, null, 2);
    return typeof s === 'string' ? s : '';
  } catch {
    return String(v);
  }
}
