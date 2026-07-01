import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyManagedSections,
  getAiInstructionsState,
  getInstructionsStatus,
  MANAGED_SECTIONS,
  NEEDS_SETUP_SENTINEL,
  readClaudeMd,
  writeAiInstructions,
} from './aiInstructions.js';

describe('aiInstructions — pure section logic', () => {
  it('reports all sections missing for empty content', () => {
    const status = getInstructionsStatus('');
    expect(status.missing).toBe(true);
    expect(status.outdated).toBe(false);
    expect(status.setupNeeded).toBe(true);
    expect(status.sections.every(s => !s.present)).toBe(true);
  });

  it('installs every managed section into empty content', () => {
    const { content, changed } = applyManagedSections('');
    expect(changed).toBe(true);
    for (const def of MANAGED_SECTIONS) {
      expect(content).toContain(`<!-- hotsheet:begin section=${def.id} v=${def.version} -->`);
      expect(content).toContain(`<!-- hotsheet:end section=${def.id} -->`);
    }
    expect(content).toContain('## Ticket-Driven Work');
    expect(content).toContain('## Testing Philosophy');
    expect(content).toContain('## Requirements Documentation');
    // HS-9250 — the scaffolded Testing Philosophy carries the adversarial /
    // state-transition clause (coverage-is-a-floor + transition-matrix + adversarial pass).
    expect(content).toContain('Coverage is a floor, not a ceiling');
    expect(content).toContain('Transition-matrix testing for stateful modules');
    expect(content).toContain('Adversarial pass on stateful changes');
  });

  it('is idempotent — applying twice changes nothing the second time', () => {
    const first = applyManagedSections('').content;
    const second = applyManagedSections(first);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first);
  });

  it('reports fresh install as present, current, and needing per-project setup', () => {
    const content = applyManagedSections('').content;
    const status = getInstructionsStatus(content);
    expect(status.missing).toBe(false);
    expect(status.outdated).toBe(false);
    expect(status.setupNeeded).toBe(false);
    const ticket = status.sections.find(s => s.id === 'ticket-driven-work')!;
    const testing = status.sections.find(s => s.id === 'testing-philosophy')!;
    const reqs = status.sections.find(s => s.id === 'requirements-documentation')!;
    expect(ticket.needsSetup).toBe(false); // no specifics block
    expect(testing.needsSetup).toBe(true);
    expect(reqs.needsSetup).toBe(true);
  });

  it('preserves user content surrounding the managed sections', () => {
    const userDoc = '# My Project\n\nSome custom guidance here.\n';
    const { content } = applyManagedSections(userDoc);
    expect(content).toContain('# My Project');
    expect(content).toContain('Some custom guidance here.');
    expect(content.indexOf('# My Project')).toBeLessThan(content.indexOf('hotsheet:begin section=ticket-driven-work'));
  });

  it('preserves a filled-in specifics block (sentinel removed) and treats it as not needing setup', () => {
    const fresh = applyManagedSections('').content;
    // Simulate the agent filling the testing specifics: replace the scaffold
    // body (incl. the needs-setup sentinel) between the specifics markers.
    const filled = fresh.replace(
      /(<!-- hotsheet:begin specifics=testing-philosophy v=\d+ -->\n)[\s\S]*?(\n<!-- hotsheet:end specifics=testing-philosophy -->)/,
      '$1### This project\'s test setup\n\n- Unit tests (`src/**/*.test.ts`): vitest.$2',
    );
    // The requirements sentinel remains; the testing one is gone.
    const status = getInstructionsStatus(filled);
    expect(status.sections.find(s => s.id === 'testing-philosophy')!.needsSetup).toBe(false);
    expect(status.sections.find(s => s.id === 'requirements-documentation')!.needsSetup).toBe(true);

    // Re-applying must NOT clobber the filled content.
    const reapplied = applyManagedSections(filled);
    expect(reapplied.changed).toBe(false);
    expect(reapplied.content).toContain('- Unit tests (`src/**/*.test.ts`): vitest.');
  });

  it('updates an outdated section in place while preserving filled specifics', () => {
    // Hand-craft a stale (v=0) testing section whose specifics are already filled.
    const stale = [
      '<!-- hotsheet:begin section=testing-philosophy v=0 -->',
      '## Testing Philosophy',
      '',
      'OLD prescribed text that should be replaced.',
      '',
      '<!-- hotsheet:begin specifics=testing-philosophy v=1 -->',
      '### This project\'s test setup',
      '',
      '- Unit tests (`test/`): jest.',
      '<!-- hotsheet:end specifics=testing-philosophy -->',
      '<!-- hotsheet:end section=testing-philosophy -->',
    ].join('\n');

    const { content, changed } = applyManagedSections(stale);
    expect(changed).toBe(true);
    // Prescribed refreshed to the current version + text (HS-9250 bumped it to v=2).
    expect(content).toContain('<!-- hotsheet:begin section=testing-philosophy v=2 -->');
    expect(content).not.toContain('OLD prescribed text');
    expect(content).toContain('**Double coverage**');
    // Filled specifics retained verbatim (no needs-setup sentinel re-added).
    expect(content).toContain('- Unit tests (`test/`): jest.');
    const testing = getInstructionsStatus(content).sections.find(s => s.id === 'testing-philosophy')!;
    expect(testing.needsSetup).toBe(false);
  });

  it('does not re-add a specifics block the user deleted entirely', () => {
    const noSpecifics = [
      '<!-- hotsheet:begin section=testing-philosophy v=1 -->',
      '## Testing Philosophy',
      '',
      '- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.',
      '- **Unit tests**: Mock external deps (filesystem, network), test real logic.',
      '- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.',
      '- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.',
      '- **Manual test plan**: keep a manual test plan doc (e.g. `docs/manual-test-plan.md`) for features that can\'t be reliably automated. **Keep it up to date** — add such features there; when you add automated coverage for a previously-manual item, remove it and note it in an "Automated Coverage Summary".',
      '- **Always fix lint and type errors before finishing**: Fix as you go, don\'t batch.',
      '<!-- hotsheet:end section=testing-philosophy -->',
    ].join('\n');
    const { content } = applyManagedSections(noSpecifics);
    // The testing section keeps no specifics block (user deleted it); only the
    // freshly-appended requirements section carries one.
    expect(content).not.toContain('specifics=testing-philosophy');
    const testingBlock = content.match(/<!-- hotsheet:begin section=testing-philosophy[\s\S]*?<!-- hotsheet:end section=testing-philosophy -->/)![0];
    expect(testingBlock).not.toContain(NEEDS_SETUP_SENTINEL);
  });

  it('marks a section outdated when its installed version is behind', () => {
    const stale = '<!-- hotsheet:begin section=ticket-driven-work v=0 -->\n## Ticket-Driven Work\n\nold\n<!-- hotsheet:end section=ticket-driven-work -->';
    const status = getInstructionsStatus(stale);
    const td = status.sections.find(s => s.id === 'ticket-driven-work')!;
    expect(td.present).toBe(true);
    expect(td.version).toBe(0);
    expect(td.outdated).toBe(true);
    expect(status.setupNeeded).toBe(true);
  });
});

describe('aiInstructions — filesystem layer', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hs-ai-instr-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('readClaudeMd returns null when absent', () => {
    expect(readClaudeMd(dir)).toBeNull();
  });

  it('writeAiInstructions creates CLAUDE.md and reports written', () => {
    const result = writeAiInstructions(dir);
    expect(result.written).toBe(true);
    const onDisk = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(onDisk).toContain('## Ticket-Driven Work');
    expect(result.state.fileExists).toBe(true);
    expect(result.state.setupNeeded).toBe(false);
  });

  it('writeAiInstructions is a no-op the second time', () => {
    writeAiInstructions(dir);
    const second = writeAiInstructions(dir);
    expect(second.written).toBe(false);
  });

  it('writeAiInstructions appends to an existing CLAUDE.md, preserving it', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Existing\n\nKeep me.\n', 'utf-8');
    writeAiInstructions(dir);
    const onDisk = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(onDisk).toContain('# Existing');
    expect(onDisk).toContain('Keep me.');
    expect(onDisk).toContain('## Requirements Documentation');
  });

  it('getAiInstructionsState detects a .claude/ project as a Claude project', () => {
    mkdirSync(join(dir, '.claude'));
    const state = getAiInstructionsState(dir);
    expect(state.detected).toBe(true);
    expect(state.fileExists).toBe(false);
    expect(state.missing).toBe(true);
  });
});
