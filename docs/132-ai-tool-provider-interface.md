# 132. AI-tool provider interface — one contract, one implementation per tool

HS-9482. Status: **design only.** One open decision (§132.9) gates the implementation
tickets; everything else here is settled enough to build against.

Umbrella for the per-tool work already shipped across
[113](113-multi-ai-tool-support.md) (the multi-tool epic), [114](114-acp-channel.md) /
[115](115-mcp-hooks-agent-channel.md) (the two drive transports),
[117](117-agent-backend-transport.md) (the transport capability table),
[118](118-adapter-mode-tool-config.md) / [119](119-tool-switch-config-prep.md) /
[120](120-agents-md-adapter-retirement.md) (config generation), and
[121](121-codex-app-server-drive.md) / [129](129-codex-model-b-terminal-hosting.md)
(the codex drive). This doc does not change what any tool does — it changes **where that
knowledge lives**.

## 132.1 The problem: one tool's identity is spelled out in eleven places

Support for a tool is not a module. It is a set of `if (tool === …)` branches and
per-tool lookup tables scattered across the server, each added by whichever ticket
needed it. Adding a tool means finding all of them; forgetting one is silent.

The current inventory — every place that names a specific tool:

| Where | What it holds |
|---|---|
| `routes/pages.tsx` | the `<option>` list in the AI-tool dropdown (hand-written HTML) |
| `api/aiInstructions.ts` | `AI_INSTRUCTION_TOOLS` — the wire enum |
| `aiInstructionsTools.ts` | `TOOLS` (path + frontmatter + detect) and `ADAPTER_FAMILY` |
| `devFeatures.ts` | `DEV_FEATURES` — the per-tool In-Development gate (docs/124) |
| `agentDisplayName.ts` | id → display name, for busy labels |
| `terminals/resolveCommand.ts` | `CLI_AGENTS`, `AGENT_BINARIES`, and a `tool === 'codex'` branch |
| `toolPrep.ts` | `skillArtifactRelPath` — a switch over every tool's main skill artifact |
| `skills.ts` | `ensureSkillsForDir`'s if-chain, plus `agent.aiTool === 'antigravity'` / `'codex'` special cases **inside** the registry loop |
| `mcpHooksAgents.ts` | the MCP-hooks registry (spawn + MCP config) |
| `acp/acpAgents.ts` | `resolveAcpAgentCommand` — a switch of ACP entrypoints |
| `agentTransport.ts` | the transport capability table |

Three of those are already registries (`TOOLS`, `AGENTS`, `DEV_FEATURES`) — the pattern
is right, the scope is too narrow. Each covers **one concern for all tools** when what
is wanted is **one tool across all concerns**.

### 132.1.1 The leak that makes this urgent

Registries are a tidiness argument. This is not:

```
src/terminals/eagerSpawn.ts        → import { prestartCodexDaemonIfNeeded } from '../codexAppServer.js'
src/terminals/registry/lifecycle.ts → import { codexTerminalNeedsDaemonEnsure, … }
src/terminals/resolveCommand.ts     → import { codexTerminalRemoteCommand, … }
src/routes/settings.ts              → import { prestartCodexDaemonIfNeeded }
src/routes/channel.ts               → import { clearCodexAppServerFailures, … }
```

Generic infrastructure — terminal spawning, the terminal registry, the settings route —
imports **one tool's module by name**. Nothing structural stops the next tool from
adding its own five imports to the same files, and at that point the generic modules
are a switch statement wearing a trench coat.

The same shape appears in the drive modules, where three tools independently export
three names for the same three concepts:

| Concept | Antigravity | OpenCode | Codex |
|---|---|---|---|
| is this tool driving? | `isAntigravityDriven` | `isAcpDriven` | `isCodexAppServerEnabled` |
| interactive permissions on? | `antigravityInteractivePermissions` | (ACP-native) | `codexInteractivePermissions` |
| run one turn | `spawnAgyRun` | `spawnAcpRun` | `spawnCodexAppServerRun` |

`spawnRun` was already unified once, by `McpHooksAgent` (HS-9339) — which is the proof
that this generalizes. It just stopped at one concern.

### 132.1.2 Why testing is the real cost

The ticket's stated motivation is *"we should be able to focus on testing ai tool
plugins more independently."* Today you cannot, because there is no seam. Testing
"does Codex work?" means testing `skills.ts` and `toolPrep.ts` and `resolveCommand.ts`
and `routes/channel.ts` — modules whose tests are about those modules, with a codex
case bolted on. There is no single object you can hand a fixture project and ask *is
this tool integration correct?*

That is the deliverable: an object per tool, and one conformance suite that runs
against all of them.

## 132.2 Goals and non-goals

**Goals**

1. One interface. Every tool — **including Claude** — is an implementation of it.
2. Adding a tool = adding one provider module + one registry line. No edits to generic
   modules, no new `if (tool === …)` anywhere.
3. Capability presence is the only feature test. Tools genuinely differ (Gemini has no
   drive; Goose has only a command; the editor tools have no runtime at all), and the
   interface must express that without a `supportsX` boolean zoo.
4. A conformance suite every provider passes, plus per-provider tests that need no
   server, no route, and no other tool.

**Non-goals**

- Changing any tool's *behavior*. This is a refactor with a test suite attached; a
  provider migration that changes what a tool does has failed.
- Building the missing integrations (a Goose drive, a Gemini drive). The interface
  should make those cheap; it does not deliver them.
- Retiring the docs/124 In-Development gates. Gating stays; it becomes a provider field.

## 132.3 What an AI-tool integration actually does

Derived from the inventory, not invented. Seven concerns:

1. **Identity** — id, display name, tier, dev gate, detection.
2. **Instructions** — the managed-section file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`
   / a rules file), its frontmatter, and whether it is adapter-family (docs/118).
3. **Skills** — the generated worklist skill/rule artifact and where it lives; also the
   main artifact path that docs/119 staleness checks read.
4. **Command** — the binary, and how `{{aiCommand}}` resolves to a launch line (which
   for codex is model-B-aware, and for Claude carries the channel flag).
5. **Drive** — the transport, running one turn, and optionally interrupt / reset /
   prestart / busy.
6. **Permissions** — the opt-in interactive-permission wiring into the §47 overlay, and
   the setting key that gates it.
7. **MCP registration** — putting the cwd-resolving `hotsheet-channel` server into the
   tool's config, in whatever format that tool uses.

Terminal hosting (docs/129 model-B) is a sub-case of *command* plus *drive*, not an
eighth concern — the terminal owns a thread and the drive discovers it, but both sides
are already expressible as a command variant plus a drive hook.

## 132.4 The interface

```ts
export interface AiToolProvider {
  readonly id: string;                       // the `ai_tool` value, lowercase
  readonly displayName: string;              // UI + busy labels
  readonly tier: 'cli-agent' | 'editor';     // docs/113 §113.2 A / B
  readonly devGate: DevGate | null;          // docs/124; null = generally available
  detect(projectRoot: string): boolean;      // PATH probe and/or folder presence

  // Optional capabilities. ABSENCE means "not supported" — there is no
  // `supportsDrive: false`, because a missing method cannot be called by mistake
  // and a boolean can drift from the method it describes.
  readonly instructions?: InstructionsCapability;
  readonly skills?: SkillsCapability;
  readonly command?: CommandCapability;
  readonly drive?: DriveCapability;
  readonly permissions?: PermissionsCapability;
  readonly mcp?: McpCapability;
}
```

```ts
interface InstructionsCapability {
  relPath: string;                  // 'CLAUDE.md' | 'AGENTS.md' | '.cursor/rules/…'
  frontmatter: string;              // written only on create
  adapterSkillsRoot: string | null; // non-null ⇒ adapter family (docs/118)
}

interface SkillsCapability {
  /** The artifact whose presence + version header answer "is this prepared?"
   *  (docs/119). `projectRoot` because OpenCode's target depends on whether the
   *  canonical Claude source exists. */
  mainArtifactRelPath(projectRoot: string): string;
  /** Generate/refresh. Idempotent; returns whether anything was written. */
  ensure(projectRoot: string, dataDir: string): boolean;
}

interface CommandCapability {
  binary: string;                                     // 'claude' | 'agy' | 'codex'
  resolve(dataDir: string, opts: CommandResolveOptions): string;
}

interface DriveCapability {
  transport: AgentTransport;                          // docs/117
  run(dataDir: string, serverPort: number, content: string): boolean | Promise<boolean>;
  interrupt?(dataDir: string): boolean;               // codex has one; agy does not
  reset?(dataDir: string): void;
  prestart?(dataDir: string): void;                   // codex daemon pre-start
  isBusy?(dataDir: string): boolean;
}

interface PermissionsCapability {
  settingKey: string;                                 // 'codex_interactive_permissions'
  ensure(projectRoot: string, dataDir: string): void; // install/remove, merge-safe
}

interface McpCapability {
  ensureConfig(): void;                               // global, idempotent
}
```

**The load-bearing rule:** outside `src/aiTools/<id>.ts`, no code may branch on a tool
id. Everything asks the provider. The generic modules in §132.1.1 stop importing
`codexAppServer.js` and start calling `provider.drive?.prestart?.(dataDir)` — a call
that is a no-op for every tool that doesn't need it, which is the whole point.

This is enforceable the way this codebase already enforces its other structural rules
(the §62 `innerHTML` allowlist, the docs/125 project-scoped-state rule): a
`no-restricted-syntax` ESLint rule flagging tool-id string literals outside
`src/aiTools/**`, with a small allowlist for the genuinely-central files (the registry,
the wire enum).

### 132.4.1 Capability matrix — what the interface has to accommodate

The real spread, which is why capabilities are optional objects rather than a fat
interface with stubs:

| Tool | instructions | skills | command | drive | permissions | mcp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| claude | ✅ `CLAUDE.md` | ✅ `.claude/skills` | ✅ +channel flag | ✅ claude-channel | ✅ native | ✅ `.mcp.json` |
| codex | ✅ adapter | ✅ `.agents/skills` | ✅ model-B aware | ✅ mcp-hooks | ✅ opt-in hooks | ✅ TOML |
| antigravity | ✅ adapter | ✅ `.agents/skills` | ✅ `agy` | ✅ mcp-hooks | ✅ opt-in hook | ✅ global JSON |
| opencode | ✅ adapter | ✅ canonical refresh | ✅ | ✅ acp | ✅ ACP-native | ✅ via session |
| gemini | ✅ `GEMINI.md` | ✅ `.gemini/skills` | ✅ | ❌ | ❌ | ❌ |
| goose | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| cursor / copilot / windsurf | ✅ rules | ✅ rules/prompts | ❌ | ❌ | ❌ | ❌ |

Goose is the useful stress case: a provider that is *only* identity plus a command. If
the interface makes that awkward, the interface is wrong.

## 132.5 Registry and resolution

`src/aiTools/registry.ts` holds the list and the lookups — `getProvider(id)`,
`listProviders()`, `listDetected(projectRoot)`. It replaces `mcpHooksAgents.ts`'s
`AGENTS`, `aiInstructionsTools.ts`'s `TOOLS`, and the `resolveAcpAgentCommand` switch;
`agentTransport.ts` becomes `getProvider(id)?.drive?.transport ?? 'claude-channel'`.

Two consumers keep a derived view rather than reading the registry directly:

- **The wire enum** (`AI_INSTRUCTION_TOOLS`) stays a literal `as const` tuple, derived
  from the registry by a test that fails when they diverge — not computed at runtime.
  A zod enum built from a mutable array loses its literal type, and the HS-9366 lesson
  was that making the wire type *derived* is what caught the HS-9322/9344 drift.
- **The dropdown** in `routes/pages.tsx` is server-rendered from `listProviders()`,
  which deletes the hand-maintained `<option>` list and makes the docs/124 gate
  filtering fall out of the provider's `devGate` field.

## 132.6 Claude is a provider, and it is the acceptance test

The ticket says "including claude", and that is the right call for a reason worth
stating: Claude is the tool whose integration is deepest and least like the others — a
*persistent* channel session rather than a spawn, native permissions, its own port
file, and the canonical source that every adapter references. An abstraction that fits
only the tools added after it was written is a hierarchy, not an interface.

So Claude migrating is not a nice-to-have; it is how we find out whether the interface
is real. Concretely it is also the safest to do **last** — everything else in Hot Sheet
assumes it works, and it has the most existing coverage to regress. Sequencing in
§132.8 reflects that.

`auto` is **not** a provider. It is a resolution *mode* — "every detected provider"
— and belongs in the registry lookup, not the registry list.

## 132.7 Conformance testing — the actual deliverable

One suite, parameterized over `listProviders()`, run against a temp fixture project.
The point is that every provider answers the same questions, so a new tool inherits the
whole suite by existing.

- **Identity.** Unique lowercase id; non-empty display name; the dev gate's `aiTool`
  matches the provider id; `detect()` on an empty dir does not throw.
- **Instructions.** `relPath` is repo-relative and inside the project; writing twice is
  idempotent; the adapter-family flag agrees with what the generator emits.
- **Skills.** `ensure()` is idempotent; the artifact it writes is the one
  `mainArtifactRelPath()` names — a mismatch is exactly the docs/119 staleness bug
  where prep reports "needed" forever.
- **Command.** `resolve()` returns a non-empty line starting with the declared binary.
- **Drive.** `transport` is a valid value; `run()` with an injected spawner reports the
  content it would send. Real spawning stays in the per-provider live tests.
- **Permissions.** `ensure()` with the setting off removes cleanly and leaves foreign
  hook entries intact — merge-safety is the property most likely to break silently.
- **Cross-provider.** No two providers claim the same id; every `AI_INSTRUCTION_TOOLS`
  entry has a provider and vice versa; every docs/124 tool gate names a real provider.

Note what this replaces: the current per-tool assertions live in `skills.test.ts`,
`toolPrep.test.ts`, `aiInstructionsTools.test.ts` and friends, where they test the
*generic* module and happen to cover a tool. Those stay (the generic modules still need
their own tests) — but "is Codex correct?" stops being spread across them.

## 132.8 Migration — additive, one concern at a time

The failure mode for a refactor this wide is a big-bang branch that changes behavior
somewhere nobody looks. So: the registry lands first and is adopted concern by concern,
each phase leaving the tree green and shippable.

| Phase | Ticket | Scope |
|---|---|---|
| **1** | HS-9490 | `src/aiTools/` + the interface + the registry + provider stubs carrying only identity (id, name, tier, devGate, detect). Adopt in `agentDisplayName` and the dropdown. Nothing else moves. |
| **2** | HS-9491 | Instructions + skills: fold `TOOLS`, `ADAPTER_FAMILY`, `skillArtifactRelPath`, and the `ensureSkillsForDir` if-chain into providers. Highest branch-count payoff. |
| **3** | HS-9492 | Command: `CLI_AGENTS` / `AGENT_BINARIES` / the codex model-B branch → `command.resolve`. |
| **4** | HS-9493 | Drive + permissions + MCP: absorb `mcpHooksAgents.ts` and `resolveAcpAgentCommand`; **close the §132.1.1 leak** — the five generic modules stop importing `codexAppServer.js`. |
| **5** | HS-9494 | Claude becomes a provider. The acceptance test for the whole design. |
| **6** | HS-9495 | The conformance suite and the ESLint backstop, so phase 1–5 gains can't erode. |

The suite arrives last only in the sense of being *complete* last; each phase adds its
slice of it as that concern moves. A phase that moves a concern without moving its
tests has not finished.

## 132.9 OPEN DECISION — in-tree interface, or loadable plugins?

Hot Sheet already has a plugin system (docs/18): a manifest, an entry point loaded from
`~/.hotsheet/plugins` at runtime, preferences, UI registration, and the
`TicketingBackend` interface. "Plugin interface" in the ticket could mean either thing,
and the answer changes the design substantially.

**Recommendation: an in-tree provider interface + registry (everything above).**

- The stated goal is independent *testing*, and that comes from the seam, not from
  dynamic loading. A conformance suite over in-tree providers delivers it fully.
- An AI-tool provider does things docs/18 plugins deliberately do not: spawn
  processes, write into the user's repo, install permission hooks, and bridge the §47
  approval overlay. Making that surface loadable from `~/.hotsheet/plugins` hands
  arbitrary third-party code the ability to run commands as the user, for no benefit
  anyone has asked for.
- Every tool we support ships with Hot Sheet. Nobody has asked to add one without
  touching the source.

**The honest case for loadable:** it is the only version where a *third party* adds
tool support without a Hot Sheet release. If the intent behind "plugin" is an
ecosystem — other people shipping tool integrations on their own schedule — then
in-tree is the wrong answer and the design needs a manifest, a capability
declaration, a version-compat check, and a trust model for the permission bridge.

**A middle option**, if that ecosystem is wanted later: build the in-tree interface
now, and keep the provider surface free of Hot Sheet internals (paths and settings in,
plain data out) so a loader can be added behind it later without redesigning. That is
strictly cheaper than deciding now, and costs nothing today — the interface in §132.4
is already written that way.

## 132.10 Other open decisions

1. **Does `auto` stay?** §132.6 treats it as a resolution mode. It could instead be
   retired in favor of "every detected tool", which is what it means. Left alone —
   no reason to churn the setting.
2. **Provider granularity for shared files.** Antigravity, OpenCode and Codex all write
   `AGENTS.md`, and today the double-write is idempotent so nothing special is needed.
   Under the interface each provider declares the same `relPath`, which stays correct
   but reads oddly. Leaving it — a "file owner" concept costs more than the oddity.
3. **Where live tests go.** `opencodeAcpLive.test.ts` and `codexModelBLive.test.ts`
   need real binaries and are excluded from the fast suites. They should move next to
   their providers, but the exclusion patterns are path-based — a follow-up, not a
   blocker.

## 132.11 Cross-references

- [113](113-multi-ai-tool-support.md) — the epic this consolidates; §113.2's A/B tiering
  becomes the provider `tier` field.
- [114](114-acp-channel.md) / [115](115-mcp-hooks-agent-channel.md) — the two drive
  transports, which become `drive.transport` values.
- [117](117-agent-backend-transport.md) — the capability table, absorbed into the
  registry; the `agent_backend` per-project override is unaffected.
- [118](118-adapter-mode-tool-config.md) / [119](119-tool-switch-config-prep.md) /
  [120](120-agents-md-adapter-retirement.md) — instruction + skills generation, which
  become the `instructions` and `skills` capabilities.
- [121](121-codex-app-server-drive.md) / [129](129-codex-model-b-terminal-hosting.md) —
  the codex drive whose leaked imports §132.1.1 is about.
- [124](124-in-development-gates.md) — the per-tool gates, which become `devGate`.
- [18](18-plugins.md) — the existing plugin system, and the subject of §132.9.
