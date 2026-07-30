/**
 * HS-9496 (docs/132 §132.9.1) — the merge-safe hooks-file writer: the first entry in the
 * host toolkit that was demonstrably written TWICE.
 *
 * `ensureAntigravityHooks` (`.agents/hooks.json`) and `ensureCodexHooks`
 * (`.codex/hooks.json`) independently implemented the same seven-step contract, and both
 * got every step right. That is the evidence for the toolkit rule — *if two plugins would
 * write the same code, it belongs in the host* — rather than an argument for it: the
 * third tool should not have to rediscover this, and a mistake in one copy would be
 * invisible next to a correct one.
 *
 * ## The contract, which is mostly about NOT destroying things
 *
 * The file belongs to the user; we occupy one group inside it. So:
 *
 * 1. **A corrupt file is left alone.** Unparseable JSON means we bail rather than
 *    overwrite — the user's hooks are worth more than ours.
 * 2. **Foreign entries survive** install, update and removal. We filter by our MARKER,
 *    never by position or by clearing the event.
 * 3. **Removal is clean.** Turning the setting off leaves no trace: our group goes, an
 *    event we emptied goes, and a file we emptied becomes empty rather than `{}`.
 * 4. **Idempotent.** Serialize and compare before writing, so a no-op change doesn't
 *    touch mtime and callers can run it on every generation pass.
 *
 * ## What varies between tools
 *
 * Only the shape, which is why one helper covers both: where the event arrays live
 * (agy puts them at the root, codex nests them under `hooks` — verified live on
 * codex-cli 0.145.0), which events and matchers, the command, the timeout, and an
 * optional `//` comment. Everything else above is identical.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** One event we install a hook group into. */
export interface HookGroupSpec {
  /** Event name, e.g. `PreToolUse`. */
  event: string;
  /** The group's matcher. Empty string for agy (it matches everything); a Rust regex or
   *  `*` for codex. */
  matcher: string;
}

export interface HooksFileSpec {
  /** Absolute path to the tool's hooks JSON. */
  path: string;
  /**
   * Substring identifying OUR hook command. This is the ownership marker, and the only
   * thing that distinguishes our group from the user's — so it must appear in the
   * command we write and be specific enough that no plausible user hook contains it.
   */
  marker: string;
  /** Key the event map nests under, or null when events live at the file root. */
  container: string | null;
  /** The command our hook entry runs. Must contain `marker`. */
  command: string;
  /** Per-hook timeout, in whatever unit the tool's schema uses. */
  timeout: number;
  /** Optional `//` comment written into the group, for tools whose files people read. */
  comment?: string;
  /** The events to install into. */
  groups: readonly HookGroupSpec[];
}

/** Is this group one WE wrote? Matched by the marker inside its command — never by
 *  position, so reordering or hand-editing the file around us stays safe. */
function isOurs(group: unknown, marker: string): boolean {
  if (typeof group !== 'object' || group === null) return false;
  const hooks = (group as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some(h =>
    typeof h === 'object' && h !== null
    && typeof (h as { command?: unknown }).command === 'string'
    && ((h as { command: string }).command).includes(marker));
}

/**
 * Install (or remove) our hook group in a tool's hooks file.
 *
 * @param want `true` to install, `false` to remove — the gating setting's value. Removal
 *   is a first-class path, not an afterthought: the setting is a toggle, and a stale hook
 *   left behind after switching it off would keep routing the agent's tool calls into a
 *   permission overlay the user has turned off.
 * @returns whether the file was written (false when unchanged, or when the existing file
 *   was corrupt and left alone).
 */
export function ensureHooksFile(spec: HooksFileSpec, want: boolean): boolean {
  let config: Record<string, unknown> = {};
  if (existsSync(spec.path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(spec.path, 'utf-8'));
      // Anything that isn't a plain object — an array, a bare string, `null` — is
      // treated the same as unparseable: leave it alone. The pre-HS-9496 agy code
      // adopted an array here and then wrote a property onto it, which serializes to
      // `[]` and silently destroys whatever was there. Refusing is the contract.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
      config = parsed as Record<string, unknown>;
    } catch { return false; } // corrupt → don't clobber the user's file
  }

  // Events either live at the root or under a container key. Copying the container
  // rather than mutating in place keeps the "delete when empty" step below simple.
  const atRoot = spec.container === null;
  const rawContainer = atRoot ? config : config[spec.container!];
  const events: Record<string, unknown> = typeof rawContainer === 'object' && rawContainer !== null && !Array.isArray(rawContainer)
    ? { ...(rawContainer as Record<string, unknown>) }
    : {};

  const hookEntry = { type: 'command', command: spec.command, timeout: spec.timeout };
  for (const { event, matcher } of spec.groups) {
    const prev = Array.isArray(events[event]) ? (events[event] as unknown[]) : [];
    // Drop any PRIOR group of ours before re-adding — that is what makes a changed
    // command or timeout an update rather than a second copy accumulating each pass.
    const others = prev.filter(g => !isOurs(g, spec.marker));
    const ours = spec.comment !== undefined
      ? { '//': spec.comment, matcher, hooks: [hookEntry] }
      : { matcher, hooks: [hookEntry] };
    const next = want ? [...others, ours] : others;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    if (next.length > 0) events[event] = next; else delete events[event];
  }

  if (atRoot) {
    // At the root, the event keys ARE config keys — write them back individually so
    // unrelated top-level settings the user has are preserved.
    for (const { event } of spec.groups) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      if (events[event] !== undefined) config[event] = events[event]; else delete config[event];
    }
  } else if (Object.keys(events).length > 0) {
    config[spec.container!] = events;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete config[spec.container!];
  }

  // An emptied file is written EMPTY rather than as `{}` — removal should leave no
  // trace, and a stray `{}` reads like a config someone meant to write.
  const serialized = Object.keys(config).length === 0 ? '' : JSON.stringify(config, null, 2) + '\n';
  const before = existsSync(spec.path) ? readFileSync(spec.path, 'utf-8') : '';
  if (serialized === before) return false; // idempotent

  mkdirSync(dirname(spec.path), { recursive: true });
  writeFileSync(spec.path, serialized, 'utf-8');
  return true;
}
