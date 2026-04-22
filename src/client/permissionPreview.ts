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
