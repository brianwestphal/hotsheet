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
 * HS-6634.
 */
export function formatInputPreview(toolName: string, raw: string): string {
  if (raw === '') return '';
  const trimmed = raw.trim();
  // Only attempt to parse strings that *look* like JSON. A plain shell
  // command that happens to start with `{` is exceptionally rare and would
  // round-trip safely if JSON.parse fails.
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return raw;

  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return raw; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;

  const obj = parsed as Record<string, unknown>;

  // Tool-specific single-field extractions where a one-liner is much more
  // useful than a key/value dump.
  const single = pickPrimaryField(toolName, obj);
  if (single !== null) return single;

  // Generic flatten: `key: value` per line; multi-line strings get indented.
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value.includes('\n')) {
        lines.push(`${key}:`);
        for (const ln of value.split('\n')) lines.push(`  ${ln}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key}: ${String(value)}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : raw;
}

function pickPrimaryField(toolName: string, obj: Record<string, unknown>): string | null {
  const str = (k: string): string | null => typeof obj[k] === 'string' ? obj[k] : null;
  switch (toolName) {
    case 'Bash':           return str('command');
    case 'WebFetch':       return str('url');
    case 'WebSearch':      return str('query');
    case 'Glob':           return str('pattern');
    case 'Read':
    case 'NotebookRead':   return str('file_path');
    default:               return null;
  }
}
