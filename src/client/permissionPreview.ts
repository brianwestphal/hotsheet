/**
 * Format a Claude tool-permission `input_preview` for display in the
 * permission popup. Claude typically sends the raw tool-input JSON object as
 * `input_preview` — `{"command":"jq -cn ..."}` etc. — which is hard to read.
 * Parse known shapes and surface just the useful text:
 *
 *   - Bash → just the `command` field
 *   - Other recognised tools → the most descriptive single field
 *   - Generic JSON object → flat `key: value` lines (multi-line strings
 *     indented under the key)
 *   - Anything else → returned untouched
 *
 * Claude's channel can truncate `input_preview` mid-JSON for long commands,
 * so when `JSON.parse` fails we fall back to a forgiving scan that still
 * extracts the primary field for known tools (appending `…` if the value
 * itself was cut). HS-6634.
 */
export function formatInputPreview(toolName: string, raw: string): string {
  if (raw === '') return '';
  const trimmed = raw.trim();
  // Only attempt to parse strings that *look* like JSON. A plain shell
  // command that happens to start with `{` is exceptionally rare and would
  // round-trip safely if JSON.parse fails.
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return raw;

  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch {
    // Probably truncated mid-JSON. For tools with a known primary field,
    // scan for that field and return whatever value we can recover.
    const key = primaryFieldKey(toolName);
    if (key !== null) {
      const extracted = extractStringField(trimmed, key);
      if (extracted !== null) return extracted.truncated ? extracted.value + '…' : extracted.value;
    }
    return raw;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;

  const obj = parsed as Record<string, unknown>;

  // Tool-specific single-field extractions where a one-liner is much more
  // useful than a key/value dump.
  const key = primaryFieldKey(toolName);
  if (key !== null && typeof obj[key] === 'string') return obj[key];

  // Generic flatten: `key: value` per line; multi-line strings get indented.
  const lines: string[] = [];
  for (const [k, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value.includes('\n')) {
        lines.push(`${k}:`);
        for (const ln of value.split('\n')) lines.push(`  ${ln}`);
      } else {
        lines.push(`${k}: ${value}`);
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${k}: ${String(value)}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(value)}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : raw;
}

/**
 * HS-7951 — pull `old_string` / `new_string` (and optional metadata) out of
 * an Edit / Write tool-permission `input_preview`. Returns `null` for any
 * tool that isn't Edit / Write, or any malformed / non-JSON / missing-field
 * shape — caller falls back to the existing `formatInputPreview` flat-JSON
 * renderer.
 *
 * Tolerant of a partial / truncated JSON body (Claude truncates `input_preview`
 * at ~2000 chars). Exposes a `truncated` flag the renderer surfaces as a
 * "… (truncated)" footer so the user knows the diff might be incomplete.
 *
 * Pure helper, no DOM. The renderer that turns this into an actual diff UI
 * lives in `src/client/editDiffPreview.tsx`.
 */
export interface EditDiffShape {
  /** Original text being replaced (empty for `Write`). */
  oldStr: string;
  /** New text. */
  newStr: string;
  /** Optional file path the Edit tool reported. */
  filePath: string | null;
  /** True when the Edit tool's `replace_all` flag was set. */
  replaceAll: boolean;
  /** True when the JSON body looked truncated mid-stream. */
  truncated: boolean;
}

export function formatEditDiff(toolName: string, raw: string): EditDiffShape | null {
  if (toolName !== 'Edit' && toolName !== 'Write') return null;
  if (raw === '') return null;
  const trimmed = raw.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;

  let parsed: unknown;
  const truncated = false;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Truncated mid-JSON. Fall back to the forgiving extractor for
    // `old_string` / `new_string` so partial diffs still render.
    const oldExtract = extractStringField(trimmed, 'old_string');
    let newExtract = extractStringField(trimmed, 'new_string');
    if (toolName === 'Edit') {
      // Edit needs both fields. If either is missing entirely, defer to flat
      // JSON renderer.
      if (oldExtract === null || newExtract === null) return null;
      return {
        oldStr: oldExtract.value,
        newStr: newExtract.value,
        filePath: extractStringField(trimmed, 'file_path')?.value ?? null,
        replaceAll: false,
        truncated: oldExtract.truncated || newExtract.truncated,
      };
    }
    // Write — only `new_string` (or its alias `content`) matters; old_string
    // is treated as empty (whole-file replace). HS-8107 — pre-fix the
    // truncated path only looked at `new_string`, so a long Write payload
    // serialised under the modern `content` field collapsed to null and
    // pushed the popup onto the mirror-xterm snapshot path, which then
    // surfaced as a solid-black body when Claude wasn't actively redrawing.
    if (newExtract === null) newExtract = extractStringField(trimmed, 'content');
    if (newExtract === null) return null;
    return {
      oldStr: '',
      newStr: newExtract.value,
      filePath: extractStringField(trimmed, 'file_path')?.value ?? null,
      replaceAll: false,
      truncated: newExtract.truncated,
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  if (toolName === 'Edit') {
    const oldStr = typeof obj.old_string === 'string' ? obj.old_string : null;
    const newStr = typeof obj.new_string === 'string' ? obj.new_string : null;
    if (oldStr === null || newStr === null) return null;
    return {
      oldStr,
      newStr,
      filePath: typeof obj.file_path === 'string' ? obj.file_path : null,
      replaceAll: obj.replace_all === true,
      truncated,
    };
  }

  // Write — `new_string` is required; `old_string` defaults to empty.
  const newStr = typeof obj.new_string === 'string'
    ? obj.new_string
    : (typeof obj.content === 'string' ? obj.content : null); // some Write variants use `content`
  if (newStr === null) return null;
  return {
    oldStr: typeof obj.old_string === 'string' ? obj.old_string : '',
    newStr,
    filePath: typeof obj.file_path === 'string' ? obj.file_path : null,
    replaceAll: false,
    truncated,
  };
}

function primaryFieldKey(toolName: string): string | null {
  switch (toolName) {
    case 'Bash':           return 'command';
    case 'WebFetch':       return 'url';
    case 'WebSearch':      return 'query';
    case 'Glob':           return 'pattern';
    case 'Read':
    case 'NotebookRead':   return 'file_path';
    default:               return null;
  }
}

/**
 * Forgiving JSON string-field extractor. Walks a (possibly truncated) JSON
 * object looking for `"key": "..."` and unescapes the value. Returns the
 * unescaped value plus a `truncated` flag if the string ran off the end of
 * input before its closing quote. Returns null if the field isn't present or
 * isn't a string.
 */
function extractStringField(raw: string, key: string): { value: string; truncated: boolean } | null {
  const needle = `"${key}"`;
  const start = raw.indexOf(needle);
  if (start === -1) return null;
  let i = start + needle.length;
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r')) i++;
  if (raw[i] !== ':') return null;
  i++;
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r')) i++;
  if (raw[i] !== '"') return null;
  i++;

  let out = '';
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\') {
      if (i + 1 >= raw.length) return { value: out, truncated: true };
      const next = raw[i + 1];
      switch (next) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
          if (i + 5 >= raw.length) return { value: out, truncated: true };
          const hex = raw.substring(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value: out, truncated: true };
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        default: out += next;
      }
      i += 2;
    } else if (ch === '"') {
      return { value: out, truncated: false };
    } else {
      out += ch;
      i++;
    }
  }
  return { value: out, truncated: true };
}
