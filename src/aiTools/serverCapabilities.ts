/**
 * HS-9503 (docs/132 §132.11.1) — the SERVER-ONLY half of the AI-tool plugin interface.
 *
 * Phase 1 established that `types.ts`, `registry.ts` and `plugins/**` import no node
 * builtins: `agentDisplayName` consumes the registry and is re-exported into the client
 * bundle, so anything the plugins import becomes client code. That splits capabilities
 * in two:
 *
 *  - **Declarative** — plain data, lives on the plugin. `instructions` (HS-9491).
 *  - **Behavioral** — needs the host (filesystem, processes). Lives HERE, keyed by
 *    plugin id, imported only by server code.
 *
 * This module is the pattern for the rest of the migration. Command resolution shells
 * out and the drive spawns processes, so phases 3–5 land here too — `serverCapabilities`
 * rather than `skillsCapabilities` for that reason. One file, one lookup, capabilities
 * added as they move.
 *
 * ## Every `ensure` is a wrapper, never a bare reference
 *
 * `ensure: (root, dataDir) => ensureClaudeSkills(root, dataDir)`, not
 * `ensure: ensureClaudeSkills`. The bare form reads the imported binding while this
 * object literal is being EVALUATED — at module scope — and that is the HS-9498 trap
 * again one level up: `routes/api.test.ts` partially mocks `skills.js`, so the moment
 * this module joined its dependency graph the whole file died at import with
 * "No 'ensureClaudeSkills' export is defined on the mock".
 *
 * Written the first time with bare references, caught immediately by that suite. The
 * wrapper defers the lookup to call time, where a missing export surfaces in the caller
 * instead of during module evaluation. Same lesson as HS-9498: resolve late.
 *
 * ## The import cycle is deliberate
 *
 * `skills.ts` imports `skillsCapabilityFor` (to iterate) and this module imports its
 * generators — a genuine cycle. It resolves because the generators are hoisted
 * `function` declarations and the wrappers above defer the read to call time. Moving
 * every generator out of `skills.ts` would separate them from the shared machinery they
 * use (`updateFile`, the version header, `ensureAdapterSkillTree`) for no gain.
 */
import { join } from 'path';

import { spawnAcpRun } from '../acp/acpDrive.js';
import type { AgentTransport } from '../agentBackendParse.js';
import { canonicalClaudeSourceExists } from '../aiInstructions.js';
import { ensureAntigravityMcpConfig } from '../antigravity.js';
import { spawnAgyRun } from '../antigravityDrive.js';
import { claudeWithChannelCommand, runClaudeChannelTrigger  } from '../channel-config.js';
import { ensureCodexMcpConfig } from '../codex.js';
import {   clearCodexAppServerFailures,
  codexDriveDiscoverEnabled,
  codexTerminalNeedsDaemonEnsure,
  codexTerminalRemoteCommand,
  hasCodexAppServerHandshakeFailed,
  isCodexAppServerEnabled,
  prestartCodexDaemonIfNeeded,
  shutdownCodexAppServers,spawnCodexAppServerRun } from '../codexAppServer.js';
import { ensureCodexDaemonRunning } from '../codexDaemonTransport.js';
import { readFileSettings } from '../file-settings.js';
import { permissionHookCommand } from '../permissionHookCommand.js';
import type { ChannelTriggerTarget } from '../routes/validation.js';
import {
  ensureAgentsFamilySkills,
  ensureClaudeSkills,
  ensureCopilotPrompts,
  ensureCursorRules,
  ensureGeminiSkills,
  ensureOpencodeSkills,
  ensureWindsurfRules,
} from '../skills.js';
import { noteUnhostedCodexLaunch } from '../terminals/codexHostedWarning.js';
import { isExecutableOnPath } from '../utils/isExecutableOnPath.js';
import { ensureHooksFile } from './hooksFile.js';

export interface SkillsCapability {
  /**
   * The artifact whose presence + version header answer "is this tool prepared?"
   * (docs/119). `projectRoot` is needed because OpenCode's target depends on whether
   * the canonical Claude source exists.
   *
   * MUST name a file `ensure()` actually writes. A mismatch is the docs/119 failure
   * where tool-prep reports "needed" forever because it checks a path nothing
   * produces — pinned by the conformance suite.
   */
  mainArtifactRelPath(projectRoot?: string): string;
  /** Generate/refresh. Idempotent; returns whether anything was written. */
  ensure(projectRoot: string, dataDir: string): boolean;
  /** Label `ensureSkillsForDir` reports for this tool. */
  platformLabel: string;
}

/** Paths are declared POSIX-style and joined by the caller. */
const CLAUDE_SKILL = '.claude/skills/hotsheet/SKILL.md';
const AGENTS_SKILL = '.agents/skills/hotsheet/SKILL.md';

const CAPABILITIES: Readonly<Record<string, SkillsCapability>> = {
  claude: {
    platformLabel: 'Claude Code',
    mainArtifactRelPath: () => CLAUDE_SKILL,
    ensure: (root: string, dataDir: string) => ensureClaudeSkills(root, dataDir),
  },
  // docs/118 — Codex and Antigravity share `.agents/skills` (the video-studio model):
  // thin adapters when the canonical Claude source exists, full bodies otherwise. The
  // double-write is idempotent, so both declaring it needs no special-casing.
  codex: {
    platformLabel: 'Codex',
    mainArtifactRelPath: () => AGENTS_SKILL,
    ensure: (root: string, dataDir: string) => ensureAgentsFamilySkills(root, dataDir),
  },
  antigravity: {
    platformLabel: 'Antigravity',
    mainArtifactRelPath: () => AGENTS_SKILL,
    ensure: (root: string, dataDir: string) => ensureAgentsFamilySkills(root, dataDir),
  },
  gemini: {
    platformLabel: 'Gemini',
    mainArtifactRelPath: () => '.gemini/skills/hotsheet/SKILL.md',
    ensure: (root: string, dataDir: string) => ensureGeminiSkills(root, dataDir),
  },
  // docs/118 §118.4a — OpenCode reads `.claude/skills` DIRECTLY, so with a canonical
  // source its generator only keeps THAT fresh (adapters would duplicate names in its
  // skill list); without one it seeds full bodies into `.agents/skills`. Which is why
  // this is the one `mainArtifactRelPath` that reads the filesystem.
  opencode: {
    platformLabel: 'OpenCode',
    // `projectRoot === undefined` must NOT fall through to a filesystem probe:
    // `canonicalClaudeSourceExists('')` resolves against the CWD, so a caller asking for
    // the static answer would get one derived from whatever project the SERVER was
    // started in. Callers that omit the root get the no-canonical-source answer, which
    // is what the pre-HS-9503 switch returned.
    mainArtifactRelPath: (projectRoot?: string) =>
      projectRoot !== undefined && projectRoot !== '' && canonicalClaudeSourceExists(projectRoot)
        ? CLAUDE_SKILL
        : AGENTS_SKILL,
    ensure: (root: string, dataDir: string) => ensureOpencodeSkills(root, dataDir),
  },
  cursor: {
    platformLabel: 'Cursor',
    mainArtifactRelPath: () => '.cursor/rules/hotsheet.mdc',
    ensure: (root: string) => ensureCursorRules(root),
  },
  copilot: {
    platformLabel: 'GitHub Copilot',
    mainArtifactRelPath: () => '.github/prompts/hotsheet.prompt.md',
    ensure: (root: string) => ensureCopilotPrompts(root),
  },
  windsurf: {
    platformLabel: 'Windsurf',
    mainArtifactRelPath: () => '.windsurf/rules/hotsheet.md',
    ensure: (root: string) => ensureWindsurfRules(root),
  },
  // goose: absent. Its conventions are unverified (not installed) — HS-9347,
  // docs/118 §118.6. Absence means "no skill format", which is the honest answer;
  // inventing one would be a guess, and every entry above is pinned by a live check.
};

/** The skills capability for a plugin id, or null when the tool has no skill format. */
export function skillsCapabilityFor(aiTool: string): SkillsCapability | null {
  return CAPABILITIES[aiTool.trim().toLowerCase()] ?? null;
}

/** Ids that declare a skills capability (for the conformance suite). */
export function skillsCapabilityIds(): string[] {
  return Object.keys(CAPABILITIES);
}

// ── Command resolution (HS-9492, docs/132 phase 3) ──────────────────────────

/**
 * Test seams, all optional. `resolveCommand.ts` already carried these as injected
 * overrides so the branches are testable without the real binary, a live daemon, or a
 * particular `$SHELL`; they move here rather than being lost. A capability whose command
 * resolution can only be exercised with the tool installed would defeat the point.
 *
 * `codexRemote` / `codexModelB` are tool-specific in a shared bag, which is a wart. The
 * alternative — per-capability dep types threaded through one caller — costs more than
 * the wart, and `ResolveOptions` already had exactly this shape.
 */
export interface CommandResolveDeps {
  isOnPath?: (bin: string) => boolean;
  defaultShell?: () => string;
  /** Whether the Claude channel is on for this project (drives the `--dangerously-…` flag). */
  channelEnabled?: boolean;
  codexRemote?: (dataDir: string) => string | null;
  codexModelB?: boolean;
}

export interface CommandCapability {
  /** The executable to look for on PATH. Usually the tool id; `agy` for Antigravity. */
  binary: string;
  /** The launch line for a `{{aiCommand}}` terminal. Falls back to the user's shell when
   *  the binary is absent — a terminal that opens a shell is better than one that fails. */
  resolve(dataDir: string, deps: CommandResolveDeps): string;
}

function shellOf(deps: CommandResolveDeps): string {
  return (deps.defaultShell ?? systemDefaultShell)();
}

function systemDefaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}

/** The plain "run the tool's REPL if it is installed" shape — every CLI agent except
 *  Claude (its channel flag) and Codex (its model-B hosting). */
function bareBinaryCommand(binary: string) {
  return (_dataDir: string, deps: CommandResolveDeps): string =>
    (deps.isOnPath ?? isExecutableOnPath)(binary) ? binary : shellOf(deps);
}

const COMMANDS: Readonly<Record<string, CommandCapability>> = {
  claude: {
    binary: 'claude',
    // HS-8349 — the MCP server name is per-project, so the channel flag mirrors
    // `slugifyDataDir`. Without the channel enabled it is the bare binary.
    resolve: (dataDir, deps) => {
      if (!(deps.isOnPath ?? isExecutableOnPath)('claude')) return shellOf(deps);
      return deps.channelEnabled === true ? claudeWithChannelCommand(dataDir) : 'claude';
    },
  },
  codex: {
    binary: 'codex',
    // HS-9429 (docs/129 model-B, default ON) — launch the terminal DAEMON-HOSTED
    // (`codex --remote … -C <projectDir>`) so it owns its own live thread and the drive
    // discovers and drives it in place. Falls through to plain `codex` when the daemon
    // isn't up, or when model-B is off (the drive then keeps its own headless thread —
    // HS-9430 deleted the model-A attach that used to chase it).
    resolve: (dataDir, deps) => {
      if (!(deps.isOnPath ?? isExecutableOnPath)('codex')) return shellOf(deps);
      const modelB = deps.codexModelB ?? codexDriveDiscoverEnabled();
      if (modelB) {
        const remote = (deps.codexRemote ?? codexTerminalRemoteCommand)(dataDir);
        if (remote !== null) return remote;
      }
      return 'codex';
    },
  },
  // HS-9319 — Antigravity is the one tool whose binary differs from its id.
  antigravity: { binary: 'agy', resolve: bareBinaryCommand('agy') },
  gemini: { binary: 'gemini', resolve: bareBinaryCommand('gemini') },
  opencode: { binary: 'opencode', resolve: bareBinaryCommand('opencode') },
  goose: { binary: 'goose', resolve: bareBinaryCommand('goose') },
  // cursor / copilot / windsurf: absent. Tier-B editor tools are not terminal agents
  // (docs/113 §113.2), so a `{{aiCommand}}` terminal for them falls back to Claude —
  // see `commandCapabilityOrDefault`.
};

/** The command capability for a tool id, or null when it is not a terminal agent. */
export function commandCapabilityFor(aiTool: string): CommandCapability | null {
  return COMMANDS[aiTool.trim().toLowerCase()] ?? null;
}

/**
 * What a `{{aiCommand}}` terminal should launch for `aiTool`.
 *
 * The fallback to Claude covers `auto`, unset, an unrecognized id, and the Tier-B editor
 * tools — all of which used to reach the same `pickClaudeCommand` through
 * `!CLI_AGENTS.has(tool)`. Expressing it as "no command capability → the default one"
 * makes Claude the DEFAULT rather than a special case, which is the same move docs/132
 * §132.6 asks for elsewhere.
 */
export function commandCapabilityOrDefault(aiTool: string): CommandCapability {
  return commandCapabilityFor(aiTool) ?? COMMANDS.claude;
}

/** Ids that declare a command capability (for the conformance suite). */
export function commandCapabilityIds(): string[] {
  return Object.keys(COMMANDS);
}


// ── Drive backing service (HS-9493, docs/132 phase 4a) ──────────────────────

/**
 * A long-lived process the drive depends on, distinct from the drive itself.
 *
 * Codex is the only implementer today (the app-server daemon, docs/121 + docs/129), and
 * the temptation was to expose its seven functions verbatim. That would be codex's API
 * with a new coat of paint — the hierarchy trap docs/132 §132.6 warns about, just aimed
 * at a different tool.
 *
 * So the concept is "the drive has a backing service", which is a real category: a spawn
 * agent like Antigravity has none, an ACP agent starts one per play, and Claude's
 * persistent channel is arguably one already and could implement this later. The
 * questions below are the ones a generic caller genuinely needs to ask — is it on, is it
 * healthy, get it ready, does a terminal spawn have to wait for it — not the ones codex
 * happens to export.
 *
 * Every method is required here rather than optional: a tool either HAS a backing
 * service (and can answer all of it) or declares none at all. Optionality belongs at the
 * `service` field, not inside it.
 */
export interface DriveBackingService {
  /** Is the drive that owns this service switched on? (docs/124 Experimental gate.) */
  isEnabled(): boolean;
  /** Has this project's handshake with the service failed? Drives the UI hiding the
   *  play surface (docs/121 §121.7). */
  hasFailed(dataDir: string): boolean;
  /** Ready the service ahead of need, so the next terminal/play doesn't pay a cold
   *  start. Best-effort and idempotent — safe to call on any lifecycle event. */
  prestart(dataDir: string): void;
  /** Forget recorded failures (a re-enable is a retry). */
  clearFailures(): void;
  /** Tear the service down (the drive was switched off). */
  shutdown(): void;
  /** Must a terminal spawn WAIT for the service to be up? True only when this project's
   *  terminal is meant to be hosted BY the service (docs/129 model-B). */
  blocksTerminalSpawn(dataDir: string): boolean;
  /** Bring it up; the caller defers the spawn until this settles. Never rejects in a way
   *  the caller must handle — a failure just means the terminal launches unhosted. */
  ensureUpForSpawn(): Promise<unknown>;
  /** A terminal just launched with `command`. Lets the service notice that it was NOT
   *  hosted after all and say so once, rather than the mismatch being silent. The
   *  caller supplies only what it already has; anything else the service reads itself. */
  noteTerminalLaunch(dataDir: string, terminalId: string, command: string): void;
}

const DRIVE_SERVICES: Readonly<Record<string, DriveBackingService>> = {
  codex: {
    isEnabled: isCodexAppServerEnabled,
    hasFailed: hasCodexAppServerHandshakeFailed,
    prestart: (dataDir) => { prestartCodexDaemonIfNeeded(dataDir); },
    clearFailures: () => { clearCodexAppServerFailures(); },
    shutdown: shutdownCodexAppServers,
    blocksTerminalSpawn: (dataDir) => codexTerminalNeedsDaemonEnsure(dataDir),
    ensureUpForSpawn: () => ensureCodexDaemonRunning(),
    // HS-9446 — model-B expects the terminal to host the driven thread. If it resolved
    // to plain `codex` the daemon was unreachable and driven turns run off-screen; say
    // so once rather than letting it be silent (the HS-9403 class). The model-B and
    // drive-enabled flags are read HERE so the caller doesn't have to know they exist.
    noteTerminalLaunch: (dataDir, terminalId, command) => {
      const aiTool: unknown = readFileSettings(dataDir).ai_tool;
      noteUnhostedCodexLaunch(dataDir, terminalId, {
        modelB: codexDriveDiscoverEnabled(),
        driveEnabled: isCodexAppServerEnabled(),
        aiTool: typeof aiTool === 'string' ? aiTool : '',
        command,
      });
    },
  },
};

/** The backing service for a tool id, or null when its drive needs none. */
export function driveServiceFor(aiTool: string): DriveBackingService | null {
  return DRIVE_SERVICES[aiTool.trim().toLowerCase()] ?? null;
}

/** Ids that declare a backing service (for the conformance suite). */
export function driveServiceIds(): string[] {
  return Object.keys(DRIVE_SERVICES);
}

/**
 * The backing service for a PROJECT, resolved from its `ai_tool`. Null for every tool
 * whose drive needs none — which is most of them, and is why the call sites below read
 * as optional chaining rather than a codex branch.
 */
export function projectDriveService(dataDir: string): DriveBackingService | null {
  const tool = readFileSettings(dataDir).ai_tool;
  return driveServiceFor(typeof tool === 'string' ? tool : '');
}

/**
 * Ready a project's drive service, if it has one. The no-op-by-default call that lets
 * `terminals/eagerSpawn.ts`, `routes/settings.ts` and `routes/channel.ts` stop importing
 * one tool's module by name (docs/132 §132.1.1). Best-effort: a throwing service must
 * never break the caller's flow, all three of which are incidental lifecycle events.
 */
export function prestartProjectDriveService(dataDir: string): void {
  try { projectDriveService(dataDir)?.prestart(dataDir); } catch { /* best-effort */ }
}

/**
 * Shut down EVERY drive backing service. Used by the process-exit path, which has no
 * project context — it just needs every long-lived child gone so none is orphaned.
 * Best-effort per service so one failure can't strand the others.
 */
export function shutdownAllDriveServices(): void {
  for (const service of Object.values(DRIVE_SERVICES)) {
    try { service.shutdown(); } catch { /* already torn down */ }
  }
}

// ── Drive (HS-9505, docs/132 phase 4b) ──────────────────────────────────────

/**
 * How Hot Sheet DRIVES a tool: which transport it speaks, and how to run one worklist
 * turn (the play button).
 *
 * Absorbs `mcpHooksAgents.ts`, which was the prototype for this whole design — HS-9339
 * unified `spawnRun` across two agents and stopped there. It collapsed cleanly, which is
 * the confirmation the interface was the right shape rather than a rationalization.
 *
 * Absence is the signal, per §132.11.2: a tool with no entry here is not driven by us at
 * all, and `resolveAgentTransport` answers `claude-channel` for it — the default, not a
 * carve-out. Claude itself has no entry YET; it is the persistent-channel path that
 * phase 5 (HS-9494) converts, and that conversion is the real test of this interface.
 */
/**
 * Context the DRIVE cannot read for itself — caller intent and test seams.
 *
 * Both fields exist for Claude (docs/132 §132.11.5): a project with git-worktree
 * followers has one channel per worktree, so `target` selects which to trigger, and
 * `isPidAlive` is how the port resolution is tested without real processes. The spawn
 * drives ignore the whole object.
 */
export interface DriveRunContext {
  target?: ChannelTriggerTarget;
  opts?: { isPidAlive?: (pid: number) => boolean };
}

export interface DriveCapability {
  /** HS-9508 — mirrors the plugin's declared transport, which is the source of truth
   *  (it is identity, and the client needs it too). `driveTransportsMatchPlugins` in the
   *  conformance suite fails if the two ever disagree. */
  transport: AgentTransport;
  /**
   * Run one worklist turn. Returns whether it started.
   *
   * `Promise<boolean>` is allowed because Claude's channel drive genuinely is async — it
   * POSTs to one or more live sessions. The spawn drives stay synchronous; the caller
   * awaits either.
   */
  run(dataDir: string, serverPort: number, content: string, ctx?: DriveRunContext): boolean | Promise<boolean>;
}

const DRIVES: Readonly<Record<string, DriveCapability>> = {
  // docs/12 — the PERSISTENT channel session. Claude is the only drive that talks to an
  // already-running agent rather than starting one, and the only one that fans out to
  // several targets. Phase 5 (HS-9494) added it; that it fits without reshaping the other
  // three is the evidence this is an interface and not a hierarchy.
  claude: { transport: 'claude-channel', run: (d, p, c, ctx) => runClaudeChannelTrigger(d, p, c, ctx) },
  // docs/115 — MCP-native agents on the Claude rails, one spawn per play.
  antigravity: { transport: 'mcp-hooks', run: (d, p, c) => spawnAgyRun(d, p, c) },
  // docs/121 — the persistent app-server session; a play is a `turn/start` on a resumed
  // thread rather than a fresh process, but the caller's contract is identical.
  codex: { transport: 'mcp-hooks', run: (d, p, c) => spawnCodexAppServerRun(d, p, c) },
  // docs/114 — ACP-native. `spawnAcpRun` re-reads the tool to pick its entrypoint, which
  // is why this entry needs no per-agent detail.
  opencode: { transport: 'acp', run: (d, p, c) => spawnAcpRun(d, p, c) },
};

/** The drive for a tool id, or null when we do not drive it (→ `claude-channel`). */
export function driveFor(aiTool: string): DriveCapability | null {
  return DRIVES[aiTool.trim().toLowerCase()] ?? null;
}

/**
 * The drive that handles a transport when the project's own tool has none — e.g. an
 * `agent_backend` override (docs/117 §117.3) forcing `claude-channel` onto a project set
 * to a different tool. Null for transports with no default, which is the documented
 * no-op the override path already had.
 */
export function driveForTransport(transport: AgentTransport): DriveCapability | null {
  const id = TRANSPORT_DEFAULT_DRIVE[transport];
  return id !== undefined ? DRIVES[id] : null;
}

/**
 * Only `claude-channel` has a default: it is the transport of the SHARED channel, which
 * any project can talk to regardless of which tool it selected. `mcp-hooks` and `acp`
 * have none on purpose — they mean "spawn THIS tool's agent", so there is no sensible
 * answer when the project's tool isn't one of them.
 */
const TRANSPORT_DEFAULT_DRIVE: Readonly<Partial<Record<AgentTransport, string>>> = {
  'claude-channel': 'claude',
};

/** Ids that declare a drive (for the conformance suite). */
export function driveIds(): string[] {
  return Object.keys(DRIVES);
}

// ── MCP registration (HS-9505) ──────────────────────────────────────────────

/**
 * Registering the cwd-resolving `hotsheet-channel` MCP server in a tool's own config.
 *
 * `binary` gates it: the config is only written when the agent is actually installed, so
 * Hot Sheet doesn't scatter entries into config files for tools the machine doesn't have.
 * The FORMAT is the tool's business (agy's global JSON, codex's TOML via `codex mcp add`)
 * — the server entry itself is shared host machinery (docs/132 §132.9.1).
 */
export interface McpConfigCapability {
  /** Executable that must be on PATH for the config write to apply. */
  binary: string;
  /** Idempotent, best-effort. */
  ensureConfig(): void;
}

const MCP_CONFIGS: Readonly<Record<string, McpConfigCapability>> = {
  antigravity: { binary: 'agy', ensureConfig: () => { ensureAntigravityMcpConfig(); } },
  codex: { binary: 'codex', ensureConfig: () => { ensureCodexMcpConfig(); } },
  // OpenCode needs none: its MCP server rides the ACP `session/new` payload, so there is
  // no config file to write (docs/114 §114.4).
};

/** The MCP-config capability for a tool id, or null when it needs none. */
export function mcpConfigFor(aiTool: string): McpConfigCapability | null {
  return MCP_CONFIGS[aiTool.trim().toLowerCase()] ?? null;
}

/** Ids that declare MCP config (for the conformance suite + the generation loop). */
export function mcpConfigIds(): string[] {
  return Object.keys(MCP_CONFIGS);
}

// ── ACP entrypoint (HS-9505) ────────────────────────────────────────────────

/**
 * The subprocess that puts an ACP-native agent into ACP-server mode.
 *
 * Was a `switch` in `acp/acpAgents.ts`. Each entrypoint is pinned by a spike and never
 * guessed — `opencode acp` was validated live against opencode 1.17.9 (HS-9330). Goose
 * and Kiro get entries when theirs are actually verified, not before.
 */
const ACP_COMMANDS: Readonly<Record<string, { command: string; args: string[] }>> = {
  opencode: { command: 'opencode', args: ['acp'] },
};

/** The ACP entrypoint for a tool id, or null when it has none. */
export function acpCommandFor(aiTool: string): { command: string; args: string[] } | null {
  return ACP_COMMANDS[aiTool.trim().toLowerCase()] ?? null;
}

// ── Interactive permissions (HS-9507) ───────────────────────────────────────

/**
 * Routing an agent's tool calls through Hot Sheet's §47 permission overlay, by installing
 * a hook into the agent's own hooks file.
 *
 * Opt-in per project and OFF by default: turning it on means the agent asks before each
 * mutating call, which is safer but not unattended. `ensure` therefore has to handle
 * removal as a first-class path — a stale hook left after switching the setting off would
 * keep routing calls into an overlay the user has disabled.
 *
 * The merge/removal/idempotence contract lives in `hooksFile.ts` (HS-9496); a capability
 * here declares only its tool's SHAPE and which setting gates it.
 */
export interface PermissionsCapability {
  /** The `FileSettings` key that turns this on. */
  settingKey: 'antigravity_interactive_permissions' | 'codex_interactive_permissions';
  /** Install or remove, per the setting. Idempotent; returns whether the file changed. */
  ensure(projectRoot: string, dataDir: string): boolean;
}

/** Marker + CLI subcommand for each agent's hook. Also what identifies OUR group in the
 *  agent's hooks file, so it must be distinctive. */
const AGY_HOOK_MARKER = '__agy-permission-hook';
const CODEX_HOOK_MARKER = '__codex-permission-hook';

const PERMISSIONS: Readonly<Record<string, PermissionsCapability>> = {
  antigravity: {
    settingKey: 'antigravity_interactive_permissions',
    // agy's events sit at the file ROOT and it takes one. Generous timeout: the hook
    // blocks until a human answers the overlay.
    ensure: (projectRoot, dataDir) => ensureHooksFile({
      path: join(projectRoot, '.agents', 'hooks.json'),
      marker: AGY_HOOK_MARKER,
      container: null,
      command: permissionHookCommand(AGY_HOOK_MARKER),
      timeout: 600,
      comment: 'Hot Sheet interactive permissions',
      groups: [{ event: 'PreToolUse', matcher: '' }],
    }, readFileSettings(dataDir).antigravity_interactive_permissions === true),
  },
  codex: {
    settingKey: 'codex_interactive_permissions',
    // codex NESTS events under `hooks` and takes two: the mutating-tool gate plus its own
    // approval requests. Matchers are Rust regexes, verified live on codex-cli 0.145.0.
    ensure: (projectRoot, dataDir) => ensureHooksFile({
      path: join(projectRoot, '.codex', 'hooks.json'),
      marker: CODEX_HOOK_MARKER,
      container: 'hooks',
      command: permissionHookCommand(CODEX_HOOK_MARKER),
      timeout: 180,
      groups: [
        { event: 'PreToolUse', matcher: '^(Bash|apply_patch|Edit|Write)$' },
        { event: 'PermissionRequest', matcher: '*' },
      ],
    }, readFileSettings(dataDir).codex_interactive_permissions === true),
  },
  // Absent for everything else. OpenCode's permissions are ACP-NATIVE (the agent supplies
  // `PermissionOption[]` on the wire, docs/114), and Claude's are native to the channel —
  // neither needs a hooks file, so neither declares one.
};

/** The permissions capability for a tool id, or null when it needs no hook wiring. */
export function permissionsFor(aiTool: string): PermissionsCapability | null {
  return PERMISSIONS[aiTool.trim().toLowerCase()] ?? null;
}

/** Ids that declare permission hooks (for the conformance suite + generation loop). */
export function permissionsIds(): string[] {
  return Object.keys(PERMISSIONS);
}