// @vitest-environment happy-dom
/**
 * HS-8781 — verbal permission-check announcements: the spoken-text mapping and
 * the queue/arbitration behavior (gate, dedup, stale-skip, speak-now vs
 * pre-empt-at-boundary).
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  _configureAnnouncerPermissionSpeechForTesting,
  _resetAnnouncerPermissionSpeechForTesting,
  announcePermission,
  permissionSpeechText,
} from './announcerPermissionSpeech.js';
import type { PermissionData } from './permissionOverlayHelpers.js';
import type { SpeakResult, SpeechEngine } from './tts.js';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function perm(over: Partial<PermissionData> = {}): PermissionData {
  return { request_id: 'r1', tool_name: 'Bash', description: 'Allow Claude to run npm test', ...over };
}

class FakeEngine implements SpeechEngine {
  readonly backend: SpeechEngine['backend'];
  readonly supportsPauseResume = false;
  spoken: string[] = [];
  constructor(backend: SpeechEngine['backend'] = 'browser') { this.backend = backend; }
  speak(text: string): Promise<SpeakResult> { this.spoken.push(text); return Promise.resolve('ended'); }
  cancel(): void { /* no-op */ }
  pause(): void { /* no-op */ }
  resume(): void { /* no-op */ }
}

afterEach(() => { _resetAnnouncerPermissionSpeechForTesting(); });

describe('permissionSpeechText', () => {
  it('prefixes the description with "Permission needed: "', () => {
    expect(permissionSpeechText(perm())).toBe('Permission needed: Allow Claude to run npm test');
  });

  it('falls back to a tool sentence when there is no description', () => {
    expect(permissionSpeechText(perm({ description: '' }))).toBe('Permission needed: Claude needs permission to use Bash.');
  });

  // HS-8794 — name the owning project so listeners away from the screen hear
  // which project is asking.
  it('names the project in the prefix when one is given', () => {
    expect(permissionSpeechText(perm(), 'Hot Sheet')).toBe('Permission needed in Hot Sheet: Allow Claude to run npm test');
  });

  it('falls back to the un-prefixed phrasing for an empty / whitespace project name', () => {
    expect(permissionSpeechText(perm(), '   ')).toBe('Permission needed: Allow Claude to run npm test');
  });

  it('summarizes (word-boundary trim + ellipsis) when the description is long', () => {
    const long = 'Allow Claude to run a very long command that goes on and on past the spoken length budget for sure';
    const out = permissionSpeechText(perm({ description: long }), '', 40);
    expect(out.startsWith('Permission needed: ')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('budget'); // tail was trimmed
  });
});

describe('announcePermission', () => {
  it('does nothing when the preference is off', async () => {
    const engine = new FakeEngine();
    _configureAnnouncerPermissionSpeechForTesting({ engine, isEnabled: () => false, getPlayer: () => null });
    announcePermission(perm());
    await flush();
    expect(engine.spoken).toEqual([]);
  });

  it('speaks immediately when nothing is narrating', async () => {
    const engine = new FakeEngine();
    _configureAnnouncerPermissionSpeechForTesting({ engine, isEnabled: () => true, getPlayer: () => null });
    announcePermission(perm());
    await flush();
    expect(engine.spoken).toEqual(['Permission needed: Allow Claude to run npm test']);
  });

  it('speaks the project name when one is passed (HS-8794)', async () => {
    const engine = new FakeEngine();
    _configureAnnouncerPermissionSpeechForTesting({ engine, isEnabled: () => true, getPlayer: () => null });
    announcePermission(perm(), 'Glassbox');
    await flush();
    expect(engine.spoken).toEqual(['Permission needed in Glassbox: Allow Claude to run npm test']);
  });

  it('dedupes by request_id', async () => {
    const engine = new FakeEngine();
    _configureAnnouncerPermissionSpeechForTesting({ engine, isEnabled: () => true, getPlayer: () => null });
    announcePermission(perm({ request_id: 'dup' }));
    announcePermission(perm({ request_id: 'dup' }));
    await flush();
    expect(engine.spoken).toHaveLength(1);
  });

  it('pre-empts upcoming segments: defers to the boundary, never interrupting the current one', async () => {
    const engine = new FakeEngine();
    let boundaryTask: (() => void | Promise<void>) | null = null;
    _configureAnnouncerPermissionSpeechForTesting({
      engine, isEnabled: () => true,
      getPlayer: () => ({ runAtNextBoundary: (t) => { boundaryTask = t; } }),
    });
    announcePermission(perm());
    await flush();
    expect(engine.spoken).toEqual([]); // current segment not interrupted
    expect(boundaryTask).not.toBeNull();
    await boundaryTask!(); // segment ended → boundary reached
    await flush();
    expect(engine.spoken).toEqual(['Permission needed: Allow Claude to run npm test']);
  });

  // HS-8816 — the boundary task must stay pending until the announcement has
  // actually FINISHED speaking. The player awaits the task before advancing the
  // reel; if the task resolved while the voice was still going, the next
  // narration segment would speak on top of the permission (overlapping audio).
  it('the boundary task stays pending until the announcement finishes (no overlap)', async () => {
    let resolveSpeak: (() => void) | null = null;
    const engine: SpeechEngine = {
      backend: 'browser',
      supportsPauseResume: false,
      speak: () => new Promise<SpeakResult>((res) => { resolveSpeak = () => res('ended'); }),
      cancel() { /* no-op */ },
      pause() { /* no-op */ },
      resume() { /* no-op */ },
    };
    let boundaryTask: (() => void | Promise<void>) | null = null;
    _configureAnnouncerPermissionSpeechForTesting({
      engine, isEnabled: () => true,
      getPlayer: () => ({ runAtNextBoundary: (t) => { boundaryTask = t; } }),
    });
    announcePermission(perm());
    await flush();

    // Reach the boundary: invoke the task as the player would and watch its
    // returned promise. It must NOT settle while the voice is still speaking.
    let settled = false;
    const taskDone = Promise.resolve(boundaryTask!()).then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);           // still speaking → reel held back

    resolveSpeak!();                        // announcement voice finishes
    await taskDone;
    expect(settled).toBe(true);            // only now may the reel advance
  });

  it('skips a permission already closed by the time it would speak', async () => {
    const engine = new FakeEngine();
    let boundaryTask: (() => void | Promise<void>) | null = null;
    let closed = false;
    _configureAnnouncerPermissionSpeechForTesting({
      engine, isEnabled: () => true,
      getPlayer: () => ({ runAtNextBoundary: (t) => { boundaryTask = t; } }),
      makeStalePredicate: () => () => closed,
    });
    announcePermission(perm());
    await flush();
    closed = true;          // user allowed/denied it during the current segment
    await boundaryTask!();
    await flush();
    expect(engine.spoken).toEqual([]); // skipped — gate already resolved
  });

  it('says nothing when there is no voice backend', async () => {
    const engine = new FakeEngine('none');
    _configureAnnouncerPermissionSpeechForTesting({ engine, isEnabled: () => true, getPlayer: () => null });
    announcePermission(perm());
    await flush();
    expect(engine.spoken).toEqual([]);
  });
});
