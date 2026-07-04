// HS-9320 — the wire: `ensureSkillsForDir` registers agy's MCP config only when
// the project targets Antigravity AND `agy` is on PATH. Isolated (mocks the
// antigravity writer + PATH detection) so it never touches the real ~/.gemini and
// doesn't disturb the real-PATH-based assertions in skills.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ensure: vi.fn(),
  onPath: vi.fn<(bin: string) => boolean>(() => false),
}));
vi.mock('./antigravity.js', () => ({ ensureAntigravityMcpConfig: h.ensure }));
vi.mock('./utils/isExecutableOnPath.js', () => ({ isExecutableOnPath: h.onPath }));

// eslint-disable-next-line import/first
import { ensureSkillsForDir } from './skills.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hs-skills-agy-'));
  mkdirSync(join(dir, '.hotsheet'), { recursive: true });
  h.ensure.mockClear();
  h.onPath.mockReset();
  h.onPath.mockReturnValue(false);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function setAiTool(tool: string): void {
  writeFileSync(join(dir, '.hotsheet', 'settings.json'), JSON.stringify({ ai_tool: tool }), 'utf-8');
}

describe('ensureSkillsForDir — Antigravity MCP registration (HS-9320)', () => {
  it('registers agy config when ai_tool=antigravity AND agy is on PATH', () => {
    setAiTool('antigravity');
    h.onPath.mockImplementation((bin) => bin === 'agy');
    ensureSkillsForDir(dir);
    expect(h.ensure).toHaveBeenCalledTimes(1);
  });

  it('does NOT register when ai_tool=antigravity but agy is not on PATH', () => {
    setAiTool('antigravity');
    h.onPath.mockReturnValue(false);
    ensureSkillsForDir(dir);
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('does NOT register when the project targets another tool (claude)', () => {
    setAiTool('claude');
    h.onPath.mockImplementation((bin) => bin === 'agy'); // agy present, but not selected
    ensureSkillsForDir(dir);
    expect(h.ensure).not.toHaveBeenCalled();
  });
});
