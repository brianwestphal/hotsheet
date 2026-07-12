// HS-9330 — extract overlay display fields from an ACP toolCall (captured OpenCode shape).
import { describe, expect, it } from 'vitest';

import { extractToolCallDisplay } from './acpToolCall.js';

// The exact `edit` toolCall captured from a live OpenCode turn (docs/114 §114.11).
const EDIT_TOOL_CALL = {
  toolCallId: 'call_683e2174a7b247a0b86fda20',
  title: '/tmp/acp-probe/hello.txt',
  kind: 'edit',
  status: 'pending',
  locations: [{ path: '/tmp/acp-probe/hello.txt' }],
  rawInput: {
    filepath: '/tmp/acp-probe/hello.txt',
    diff: 'Index: hello.txt\n@@ -0,0 +1,1 @@\n+hi from acp\n',
  },
  content: [{ type: 'diff', path: '/tmp/acp-probe/hello.txt', oldText: '', newText: 'hi from acp\n' }],
};

describe('extractToolCallDisplay (HS-9330)', () => {
  it('maps a captured edit toolCall to kind / title / diff', () => {
    const d = extractToolCallDisplay(EDIT_TOOL_CALL);
    expect(d.tool_name).toBe('edit');
    expect(d.description).toBe('/tmp/acp-probe/hello.txt');
    expect(d.input_preview).toContain('+hi from acp'); // the diff, not JSON
  });

  it('falls back to JSON of rawInput when there is no diff (e.g. a bash tool)', () => {
    const d = extractToolCallDisplay({ kind: 'bash', title: 'Run', rawInput: { command: 'ls -la' } });
    expect(d.tool_name).toBe('bash');
    expect(d.description).toBe('Run');
    expect(d.input_preview).toContain('"command"');
    expect(d.input_preview).toContain('ls -la');
  });

  it('uses kind as the description when there is no title', () => {
    const d = extractToolCallDisplay({ kind: 'read', rawInput: { path: '/etc/hosts' } });
    expect(d.description).toBe('read');
  });

  it('is defensive against a missing / malformed toolCall', () => {
    expect(extractToolCallDisplay(undefined)).toEqual({ tool_name: 'tool', description: 'tool', input_preview: '' });
    expect(extractToolCallDisplay(null)).toEqual({ tool_name: 'tool', description: 'tool', input_preview: '' });
    expect(extractToolCallDisplay('nope')).toEqual({ tool_name: 'tool', description: 'tool', input_preview: '' });
    expect(extractToolCallDisplay({ kind: 42 }).tool_name).toBe('tool'); // wrong-typed kind
  });

  it('caps a huge preview at 2000 chars', () => {
    const d = extractToolCallDisplay({ kind: 'edit', rawInput: { diff: 'x'.repeat(5000) } });
    expect(d.input_preview.length).toBe(2000);
  });
});
