# 132. AI-tool plugin interface — one contract, one implementation per tool

HS-9482. Status: **decided; phase 1 SHIPPED (HS-9490), phases 2–8 open.** Maintainer decision (2026-07-29): this is a
**new plugin interface specific to AI-tool integration** — not the docs/18
`TicketingBackend` and not an extension of it — which **reuses docs/18's supporting
subsystems** where they fit, the custom config UI first among them (§132.9).

Umbrella for the per-tool work already shipped across
[113](113-multi-ai-tool-support.md) (the multi-tool epic), [114](114-acp-channel.md) /
[115](115-mcp-hooks-agent-channel.md) (the two drive transports),
[117](117-agent-backend-transport.md) (the transport capability table),
[118](118-adapter-mode-tool-config.md) / [119](119-tool-switch-config-prep.md) /
[120](120-agents-md-adapter-retirement.md) (config generation), and
[121](121-codex-app-server-drive.md) / [129](129-codex-model-b-terminal-hosting.md)
(the codex drive). This doc does not change what any tool does — it changes **where that
knowledge lives**.

## 132.1 The problem: one tool's identity is spelled out in a dozen places

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
| `file-settings.ts` | each tool's setting keys as `FileSettings` zod fields (`antigravity_interactive_permissions`, `codex_interactive_permissions`, `dev_tool_*`) |
| `routes/pages.tsx` + `client/settingsDialog.tsx` | each tool's settings UI: hand-written `<div class="settings-field" style="display:none">`, a hand-written `byIdOrNull` binding, and a `revealAgyPerms` branch (`tool === 'antigravity' ? … : tool === 'codex' ? …`) |

Three of those are already registries (`TOOLS`, `AGENTS`, `DEV_FEATURES`) — the pattern
is right, the scope is too narrow. Each covers **one concern for all tools** when what
is wanted is **one tool across all concerns**.

The last row is the same disease in the settings UI, and it is the one the maintainer
pointed at: adding a third tool with an opt-in toggle means hand-writing HTML in
`pages.tsx`, a binding in `settingsDialog.tsx`, a reveal branch, **and** a zod field in
`file-settings.ts`. §132.9.2 makes that a declaration.

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
2. Adding a tool = adding one plugin module + one registry line. No edits to generic
   modules, no new `if (tool === …)` anywhere.
3. Capability presence is the only feature test. Tools genuinely differ (Gemini has no
   drive; Goose has only a command; the editor tools have no runtime at all), and the
   interface must express that without a `supportsX` boolean zoo.
4. A conformance suite every plugin passes, plus per-plugin tests that need no
   server, no route, and no other tool.
5. **The host carries the machinery** (§132.9). A plugin declares what is specific to
   its tool and calls built-in helpers for the rest; if two plugins would write the
   same code, that code belongs in the host. A thin interface over N copies of the
   same logic would trade one problem for a tidier one.

**Non-goals**

- Changing any tool's *behavior*. This is a refactor with a test suite attached; a
  plugin migration that changes what a tool does has failed.
- Building the missing integrations (a Goose drive, a Gemini drive). The interface
  should make those cheap; it does not deliver them.
- Retiring the docs/124 In-Development gates. Gating stays; it becomes a plugin field.

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
export interface AiToolPlugin {
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

  /** §132.9.2 — the plugin's own settings, declared not hand-written. Rendered by
   *  the docs/18 config-UI renderer, revealed when this tool is selected, and
   *  contributed to the `FileSettings` schema. */
  readonly preferences?: PluginPreference[];
  readonly configLayout?: ConfigLayoutItem[];
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
id. Everything asks the plugin. The generic modules in §132.1.1 stop importing
`codexAppServer.js` and start calling `plugin.drive?.prestart?.(dataDir)` — a call
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

Goose is the useful stress case: a plugin that is *only* identity plus a command. If
the interface makes that awkward, the interface is wrong.

## 132.5 Registry and resolution

`src/aiTools/registry.ts` holds the list and the lookups — `getPlugin(id)`,
`listPlugins()`, `listDetected(projectRoot)`. It replaces `mcpHooksAgents.ts`'s
`AGENTS`, `aiInstructionsTools.ts`'s `TOOLS`, and the `resolveAcpAgentCommand` switch;
`agentTransport.ts` becomes `getPlugin(id)?.drive?.transport ?? 'claude-channel'`.

Two consumers keep a derived view rather than reading the registry directly:

- **The wire enum** (`AI_INSTRUCTION_TOOLS`) stays a literal `as const` tuple, derived
  from the registry by a test that fails when they diverge — not computed at runtime.
  A zod enum built from a mutable array loses its literal type, and the HS-9366 lesson
  was that making the wire type *derived* is what caught the HS-9322/9344 drift.
- **The dropdown** in `routes/pages.tsx` is server-rendered from `listPlugins()`,
  which deletes the hand-maintained `<option>` list and makes the docs/124 gate
  filtering fall out of the plugin's `devGate` field.

## 132.6 Claude is a plugin, and it is the acceptance test

The ticket says "including claude", and that is the right call for a reason worth
stating: Claude is the tool whose integration is deepest and least like the others — a
*persistent* channel session rather than a spawn, native permissions, its own port
file, and the canonical source that every adapter references. An abstraction that fits
only the tools added after it was written is a hierarchy, not an interface.

So Claude migrating is not a nice-to-have; it is how we find out whether the interface
is real. Concretely it is also the safest to do **last** — everything else in Hot Sheet
assumes it works, and it has the most existing coverage to regress. Sequencing in
§132.8 reflects that.

`auto` is **not** a plugin. It is a resolution *mode* — "every detected plugin"
— and belongs in the registry lookup, not the registry list.

## 132.7 Conformance testing — the actual deliverable

One suite, parameterized over `listPlugins()`, run against a temp fixture project.
The point is that every plugin answers the same questions, so a new tool inherits the
whole suite by existing.

- **Identity.** Unique lowercase id; non-empty display name; the dev gate's `aiTool`
  matches the plugin id; `detect()` on an empty dir does not throw.
- **Instructions.** `relPath` is repo-relative and inside the project; writing twice is
  idempotent; the adapter-family flag agrees with what the generator emits.
- **Skills.** `ensure()` is idempotent; the artifact it writes is the one
  `mainArtifactRelPath()` names — a mismatch is exactly the docs/119 staleness bug
  where prep reports "needed" forever.
- **Command.** `resolve()` returns a non-empty line starting with the declared binary.
- **Drive.** `transport` is a valid value; `run()` with an injected spawner reports the
  content it would send. Real spawning stays in the per-plugin live tests.
- **Permissions.** `ensure()` with the setting off removes cleanly and leaves foreign
  hook entries intact — merge-safety is the property most likely to break silently.
- **Cross-plugin.** No two plugins claim the same id; every `AI_INSTRUCTION_TOOLS`
  entry has a plugin and vice versa; every docs/124 tool gate names a real plugin.

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
| **1** | HS-9490 ✅ | `src/aiTools/` + the interface + the registry + plugin stubs carrying only identity. Adopted in `agentDisplayName` and the dropdown. **SHIPPED** — see §132.12 for what building it changed about the design. |
| **2a** | HS-9491 ✅ | Instructions: `TOOLS` + `ADAPTER_FAMILY` → the plugin's `instructions` capability. **SHIPPED.** |
| **2b** | HS-9503 ✅ | Skills: `skillArtifactRelPath` + the `ensureSkillsForDir` if-chain → `aiTools/serverCapabilities.ts` (§132.11.1). **SHIPPED.** |
| **3** | HS-9492 ✅ | Command: `CLI_AGENTS` / `AGENT_BINARIES` / the codex model-B branch → `command.resolve`. **SHIPPED** — first of the five §132.1.1 leaks closed. |
| **4a** | HS-9493 ✅ | **The §132.1.1 leak is closed** — no generic module imports `codexAppServer` any more, via the drive BACKING SERVICE concept. |
| **4b** | HS-9505 ✅ | Drive + MCP + ACP absorbed — `mcpHooksAgents.ts` **deleted**, `agentTransport` is one lookup, `triggerChannel` dispatches to `drive.run`. |
| **4c** | HS-9507 ✅ | Permissions capability + the shared hook-command builder (§132.11.4). |
| **5** | HS-9494 ✅ | Claude becomes a plugin. **The acceptance test passed** — see §132.11.5. |
| **6** | HS-9496 ◐ | Extract the §132.9.1 toolkit. **Hooks-file helper SHIPPED** (`aiTools/hooksFile.ts`); the rest of the table remains. |
| **7** | HS-9497 | The §132.9.2 config-UI reuse: storage adapter behind the docs/18 renderer, then per-tool settings become `preferences` declarations. |
| **8** | HS-9495 ✅ | The conformance suite and the ESLint backstop, so the earlier gains can't erode. |

The suite arrives last only in the sense of being *complete* last; each phase adds its
slice of it as that concern moves. A phase that moves a concern without moving its
tests has not finished.

## 132.9 Built-in support — what the host provides so a plugin stays thin

Maintainer decision (2026-07-29), two parts: this is a **new interface specific to
AI-tool integration** rather than the docs/18 `TicketingBackend`, and **the host should
carry general mechanisms for supporting AI tools** rather than making each plugin
reimplement them.

That second half matters more than it sounds. An interface alone would let every tool
hand-roll its own hooks-file merge, its own skill-tree writer, its own permission
plumbing — which is roughly what happened already, and is why Antigravity and Codex
have two implementations of the same merge-safe hook install. The target shape is: **a
plugin declares what is specific to its tool and calls host helpers for everything
else.** A new tool that follows a common shape (AGENTS.md + a skills tree + a hooks
file + a spawn drive) should be close to declarative.

### 132.9.1 The toolkit — generic mechanisms plugins compose

Most of these already exist as generic code; the work is exposing them deliberately as
a toolkit rather than leaving them as functions a tool happens to import.

| Helper | Status today | Note |
|---|---|---|
| **Merge-safe hooks-file writer** (`aiTools/hooksFile.ts`) | **SHIPPED (HS-9496)** | The proof the rule is not hypothetical — see below. |
| Managed sections — markers, versioning, `applyManagedSections` / `removeManagedSections`, `planAdapterConversion` (docs/118, 120) | already generic in `aiInstructions.ts` | Only per-tool DATA moves to plugins. If a plugin ends up owning section logic, the split is wrong. |
| Adapter skill-tree writer (`ensureAdapterSkillTree`) + the adapter-vs-full mode decision | generic, called per tool | Three tools already share it; make it the default path. |
| The channel MCP server entry (`getChannelServerPath`, `buildHotsheetMcpServerEntry`) | generic | Each plugin only supplies its config FORMAT (JSON / TOML / ACP session field). |
| ~~Merge-safe hooks-file install/remove~~ | done, above | |
| The §47 permission bridge | three implementations (ACP option-driven, agy PreToolUse hook CLI, codex hooks CLI) | A host-side "ask the user, get a decision" surface, with plugins supplying only the transport-specific adapter. |
| Spawn + stdio/JSONL framing, heartbeats, busy reporting | partly generic (`acpFraming.ts`), partly per-tool | Drive-side commonality worth consolidating as the third and fourth drives land. |
| Commands Log transcript entries | generic | Plugins emit; they should not know the log's shape. |

The rule of thumb: **if two plugins would write the same code, it belongs in the
toolkit.** The merge-safe hooks helper was the proof, and extracting it (HS-9496) taught
two things worth applying to the rest of the table:

- **The duplication was hiding a real difference in safety.** Both copies were correct on
  the paths their own tests covered, but the agy one adopted a non-object JSON file (an
  array, a bare string) and wrote a property onto it — which serializes to `[]` and
  destroys whatever the user had. One shared implementation gets one answer, and that
  answer is now "refuse and leave it alone", tested for both shapes.
- **Parameterize the SHAPE, not the behavior.** What actually differed between the two
  was four things: where event arrays live (agy at the root, codex nested under `hooks`),
  which events and matchers, the command and timeout, and an optional `//` comment.
  Everything else — merge, replace-don't-accumulate, clean removal, idempotence,
  don't-clobber — was identical and is now written once.

### 132.9.2 Reused from docs/18 — the custom config UI

The docs/18 plugin system already has a declarative settings vocabulary and a renderer,
and AI-tool plugins should use them rather than growing a parallel one:

- **Reused:** `PluginPreference` / `ConfigLayoutItem` (the vocabulary), and
  `client/pluginConfigDialog.tsx`'s `renderConfigLayout` / `createPreferenceRow` /
  the per-type input builders (the renderer).
- **NOT reused:** the loader, the manifest-on-disk, `TicketingBackend`, and the sync
  engine. Those are docs/18's *identity*, not its support.

**The decoupling this needs.** The renderer is currently welded to plugin storage in
three places, and AI-tool settings live somewhere else entirely:

| | docs/18 plugin | AI-tool plugin |
|---|---|---|
| project-scope key | `plugin:<id>:<key>` in settings | a plain `FileSettings` key (`codex_interactive_permissions`) |
| global-scope | `getPluginGlobalConfig` / `setPluginGlobalConfig` | `~/.hotsheet` global config |
| layer routing | n/a | docs/95 shared-vs-local + the docs/124 `dev_` prefix |
| validation | `validatePluginField(pluginId, …)` | zod on `FileSettings` |

So: extract a **storage adapter** behind the renderer — read, write, validate — with
the existing plugin store as one implementation and file-settings (docs/95-scope-aware)
as another. The renderer keeps rendering; it stops knowing where values live. That is a
small, self-contained refactor and it is what makes the reuse honest rather than a
copy-paste of the dialog.

**What it buys.** The three hand-written pieces per tool in §132.1's last row collapse
to a `preferences` declaration on the plugin: the field renders, it is revealed when
that tool is selected (the plugin owns it, so the `revealAgyPerms` branch disappears),
and its key is contributed to the `FileSettings` schema instead of being hand-added.

### 132.9.3 Registration stays in-tree

Plugins are declared in the registry (§132.5), not loaded from `~/.hotsheet/plugins`.
Every tool we support ships with Hot Sheet, and an AI-tool plugin spawns processes,
writes into the user's repo, installs permission hooks and bridges the approval
overlay — a surface worth keeping first-party until someone actually wants a
third-party ecosystem.

That is a decision about *registration*, not about the interface, and it is
deliberately reversible: the plugin surface takes paths and settings in and returns
plain data, so a loader can be slotted behind the registry later without redesigning
anything above. **Keep it that way** — a plugin that reaches into Hot Sheet internals
is the thing that would make this irreversible.

## 132.10 Other open decisions

1. **Does `auto` stay?** §132.6 treats it as a resolution mode. It could instead be
   retired in favor of "every detected tool", which is what it means. Left alone —
   no reason to churn the setting.
2. **Plugin granularity for shared files.** Antigravity, OpenCode and Codex all write
   `AGENTS.md`, and today the double-write is idempotent so nothing special is needed.
   Under the interface each plugin declares the same `relPath`, which stays correct
   but reads oddly. Leaving it — a "file owner" concept costs more than the oddity.
3. **Where live tests go.** `opencodeAcpLive.test.ts` and `codexModelBLive.test.ts`
   need real binaries and are excluded from the fast suites. They should move next to
   their plugins, but the exclusion patterns are path-based — a follow-up, not a
   blocker.

## 132.11 What phase 1 changed about this design (HS-9490, shipped)

Three refinements the doc did not anticipate, recorded because they are the kind of
thing a later phase would otherwise re-litigate.

**1. The pure core must stay client-safe, so `detect` became data.** `agentDisplayName.ts`
is re-exported into the CLIENT bundle (`src/client/agentName.ts`), and it is the first
consumer of the registry — so the registry and every plugin module transitively become
client code. A `detect(projectRoot): boolean` closure would have pulled `fs` into the
browser bundle and broken the build.

So detection is declared as a `DetectionSpec` (`{ binaries, paths }`) and evaluated by
`aiTools/detect.ts`, which is server-only. This is strictly better than the constraint
that forced it: all nine hand-written predicates turned out to be the same expression —
*any binary on PATH, or any of these paths present* — so this is the first entry in the
§132.9.1 toolkit, written once and tested once instead of nine times. The rule it
establishes: **`aiTools/types.ts`, `aiTools/registry.ts` and `aiTools/plugins/**` import
no node builtins.** A capability that needs the filesystem takes it as an injected
dependency or lives in a server-only sibling.

**2. `displayName` alone was not enough — plugins carry two names.** The existing
surfaces disagree, and collapsing them would have changed user-visible strings:
`agentDisplayName` says "Claude" / "Gemini" / "Copilot" (they land in running text —
"Gemini finished"), while the dropdown and instruction states say "Claude Code" /
"Gemini CLI" / "GitHub Copilot". Both are correct for their context, so the interface
has `displayName` (short) and `productName` (full). Six of the nine tools have them
identical, which is why one field looked sufficient on paper.

**3. The docs/124 gate filter stays client-side.** §132.5 said generating the dropdown
would make gate filtering "fall out of" `devGate`. Half true: the option LIST now comes
from the registry, but `applyAiToolDevGating` still runs in the client because it
depends on per-project gate settings and the currently-selected tool — neither of which
the server render knows. What the registry actually removed is the hand-maintained
`<option>` list, which is the part that drifted.

Also settled by building it: the plugin declares `devGateKey` duplicated from
`DEV_FEATURES`, with a conformance test that fails on drift, rather than deriving it —
same derive-and-pin approach as the wire enum, and for the same reason.

**One divergence found, and since resolved.** Eight tools' two detection predicates
agreed; Claude's did not — instructions counted a committed `CLAUDE.md`, skills
generation did not, so such a project got its instruction file maintained while its
skills were never generated. Phase 1 recorded the union in the plugin with nothing
consuming it and filed **HS-9500** rather than picking a winner silently, since either
choice changes real behavior. Maintainer decision (2026-07-29): **union everywhere**,
and `skills.ts` was brought into line immediately. So phase 2 inherits one definition
both call sites already agree on, instead of a choice disguised as a refactor — which
is the whole reason phase 1 was asked to compare them.

### 132.11.2 A leaked API is not an interface (HS-9493)

Five generic modules imported `codexAppServer` by name, and the obvious fix was to expose
its seven functions on a capability. That would have been codex's API with a new coat of
paint — the same hierarchy trap §132.6 warns about for Claude, aimed at a different tool.

What made it a real category was asking what a GENERIC caller needs to know, rather than
what codex happens to export. The answer is that **the drive may have a long-lived
backing service**: is it on, is it healthy, get it ready, must a terminal spawn wait for
it, tell it a terminal launched. Antigravity spawns per play and has none; OpenCode
starts one per ACP session; Claude's persistent channel arguably IS one and could
implement this later. Codex being the only implementer today is a fact about today.

Two shape decisions fell out of that framing:

- **Absence is the signal, and it is at the FIELD.** `driveServiceFor(id)` returns null
  for a tool with no service, and every method on the interface is required. A caller
  that gets a service can ask it anything without probing for method existence; a caller
  that gets null skips the whole concern. Optional methods inside would have recreated
  the `supportsX` problem one level down.
- **The caller supplies only what it already has.** `noteTerminalLaunch(dataDir,
  terminalId, command)` — the model-B and drive-enabled flags it actually depends on are
  read by the service. The old call site passed them in, which is how
  `terminals/registry/lifecycle.ts` came to import two codex predicates.

### 132.11.1 Capabilities split into declarative and behavioral (HS-9491)

Phase 2 was specified as one step and landed as two, because the client-safety rule from
phase 1 cuts straight through the capability list.

**Instructions is pure data** — `relPath`, `frontmatter`, `adapterSkillsRoot` are three
strings. It sits on the plugin object exactly as §132.4 imagined, and
`aiInstructionsTools.ts` now derives its table from the registry while keeping every bit
of the machinery (markers, versioning, `planAdapterConversion`) generic.

**Skills is not.** `ensure()` is the `ensureSkillsForDir` if-chain, and `skills.ts` has
33 `fs` calls; `mainArtifactRelPath()` calls `canonicalClaudeSourceExists()` for OpenCode.
Either one on the plugin object drags `fs` into the browser bundle and breaks the client
build.

So the interface has two kinds of capability:

- **Declarative** — plain data, lives on the plugin, client-safe. Instructions today.
- **Behavioral** — needs the host (filesystem, processes), lives in a **server-only
  sibling keyed by plugin id**. Skills, and by inspection command / drive / permissions
  too: command resolution shells out, the drive spawns processes.

That means §132.4's single interface is really "the declarative half plus a
server-side companion". **HS-9503 settled the sibling: `src/aiTools/serverCapabilities.ts`,
one file, one lookup per capability, capabilities added as they move.** Phases 3–5 land
there — command resolution shells out, the drive spawns processes.

**Phase 3 added a third (HS-9492): a capability's fallback should read as the DEFAULT,
not a carve-out.** `resolveCommand` used to branch on `!CLI_AGENTS.has(tool)` to send
`auto`, unset, unknown ids and the Tier-B editor tools down the Claude path. That is now
`commandCapabilityOrDefault(tool)` — no command capability means the Claude one — which
says the same thing without naming Claude as an exception. Same move §132.6 asks for when
Claude finally becomes a plugin.

Also worth copying: when a capability needs a string another module already builds, MOVE
the builder somewhere both can import rather than duplicating it. `claudeWithChannelCommand`
had a second consumer in `workers/launchWorker.ts`, so it moved to `channel-config.ts`
beside the slug it mirrors — importing it back from `terminals/` would have been a cycle,
and re-typing the flag would have been two spellings of one contract.

**Two rules the sibling carries, both learned the hard way:**

1. **Wrap, never reference.** `ensure: (root, dataDir) => ensureClaudeSkills(root, dataDir)`,
   not `ensure: ensureClaudeSkills`. The bare form reads the imported binding while the
   capability table is being EVALUATED, at module scope — which is the HS-9498 trap one
   level up. Written the bare way first, it took `routes/api.test.ts` and
   `routes/attachmentCopyCrossProject.test.ts` down in full, because they partially mock
   `skills.js` for unrelated reasons. Pinned by `serverCapabilitiesImport.test.ts`.
2. **Never let an omitted argument become a filesystem probe of the CWD.**
   `mainArtifactRelPath()` with no `projectRoot` must return the same answer as one for a
   project with no canonical source. The first version passed `''` through to
   `canonicalClaudeSourceExists`, which resolves against `process.cwd()` — so the answer
   depended on which project the server was started in. Caught by its own conformance
   test, pinned by "omitting projectRoot never probes the CWD".

This is not a retreat from the design — the plugin is still the one place a tool is
defined, and `getPlugin(id)` is still the one lookup. It is a constraint on WHERE each
half lives, and it was discoverable only by building it.

### 132.11.3 The prototype collapsed cleanly (HS-9505)

`mcpHooksAgents.ts` was HS-9339's unification of `spawnRun` across two agents — the
existing proof that this generalizes, and §132.1.1 predicted it "should collapse cleanly.
If it doesn't, that's a signal about the interface."

It did, and the module is deleted. Its descriptor split into three capabilities that each
answer one question — `driveFor` (transport + run a turn), `mcpConfigFor` (binary +
write the config), `acpCommandFor` (the ACP entrypoint) — and the split was not
cosmetic: **OpenCode drives but needs no MCP config** (its server rides the ACP
`session/new` payload), and **Antigravity and Codex write config but are not ACP**. One
combined descriptor would have carried a field that is meaningless for a third of its
members, which is what optional-fields-inside looks like before it becomes a habit.

`resolveAgentTransport` is now one lookup instead of two membership tests, and a tool we
do not drive falls through to `claude-channel` — the DEFAULT, not a carve-out. Claude has
no drive entry YET; that is phase 5's conversion, and it is the real test of whether this
interface holds.

### 132.11.4 Not every helper can move (HS-9507)

The permission-hook command builder was the third copy of one function — the HS-9496
pattern again — and the obvious finish was to extract it into `aiTools/` with its
callers. It cannot go there.

It resolves the Hot Sheet CLI from `import.meta.url` and assumes it is a SIBLING of the
entry point: `dist/cli.js` in prod (everything bundles), `src/cli.ts` in dev (nothing
does). One directory down, the dev probe misses and falls through to a `dist/cli.js` that
a dev tree may not have — and the resulting hook points at nothing. The failure mode is
that **the permission overlay simply never appears**: no error, no log line, the agent
running unattended when the user asked to be asked.

So the shared builder lives at `src/` root, next to the CLI it resolves, and only its
CALLERS moved into the capability layer. Two things generalize from that:

- **A module whose behavior depends on its own location is not freely movable.** Check for
  `import.meta.url` / `__dirname` before treating an extraction as a lift.
- **The test that makes it safe is "does the resolved path exist".** Nothing asserted that
  before; `permissionHookCommand.test.ts` does now, and it was verified against a copy
  placed one directory deeper — which fails with the resolved path in the message.

### 132.11.5 Claude fitted, and cost the interface two allowances (HS-9494)

§132.6 set the bar: this is an interface only if the tool it was **not** written around
fits without reshaping the others. Claude fits. Nothing about the other three drives
changed, `resolveAgentTransport` reads Claude's transport from the table like anyone
else's, and `triggerChannel` has no branch left — it picks the drive for the effective
transport and runs it.

It was not free. Claude needed two widenings, both anticipated by the phase-5 ticket as
legitimate outcomes rather than failures:

1. **`run` may return a promise.** Claude's drive POSTs to an already-running session;
   every other drive starts a process and returns synchronously. `boolean | Promise<boolean>`
   costs the spawn drives nothing and the caller awaits either.
2. **`run` takes a caller CONTEXT.** A project with git-worktree followers has one channel
   per worktree, so `target` selects which to trigger — caller intent the drive cannot
   read for itself. `isPidAlive` rides along as the test seam for port resolution.

Both are real generalizations rather than Claude-shaped holes: "talks to something already
running" and "the caller knows which instance" are categories a future tool can land in.
The test is whether a THIRD kind of drive needs a third allowance; if it does, the
interface is accreting rather than generalizing.

**What Claude does NOT declare is as informative as what it does.** No permissions
capability (native to the channel), no MCP config (the per-project `.mcp.json` the channel
already writes), no backing service (its session is not ours to start or stop), no ACP
entrypoint. Absence carries that, per §132.11.2, and the conformance suite asserts each
one — so a capability appearing there later is a deliberate choice rather than a drive-by.

The one asymmetry that stays: `CLAUDE.md` + `.claude/skills` are the canonical source the
adapter family references, so `canonicalClaudeSourceExists` is consulted BY other plugins.
That is a real fact about the ecosystem, not a modelling failure — §132.6 said not to
invert it to make the shape look tidier, and it has not been.

### 132.11.6 The backstop found a whole layer the epic had missed (HS-9495)

The `no-restricted-syntax` rule flagging tool-id literals outside `src/aiTools/**` was
expected to be a ratchet — something that holds ground already taken. It found new ground
instead: **every violation was in CLIENT code, and nothing else fired.**

That is not chance. docs/132 was scoped to the server, and the client cannot reach
`aiTools/serverCapabilities.ts` (it imports process-spawning modules), so the client
re-derives what it needs. `src/client/agentBackend.ts` holds a second copy of the drive
transports with nothing pinning it against the server's — the exact drift class this epic
removed, reintroduced one layer up. Filed as **HS-9508**.

Two things worth keeping from how it was built:

- **A rule is only worth having if it is calibrated.** Measured first: 28 literals across
  12 files, nearly all in modules named after the tool they implement. Exempting those
  left four real hits and zero noise. The config's own warning — a rule that noisy
  "trains reflexive allowlisting" — is the failure mode to avoid, and the check is
  cheap: count the hits before writing the rule.
- **Allowlist files individually, not directories.** All four hits are under
  `src/client/`, and `src/client/**` would have been one line. Listing them separately
  means a NEW client tool-id branch still fires, so the debt is frozen rather than
  licensed.

The suite gained its own proof at the same time: a hypothetical plugin, never registered,
put through the same identity and detection expectations as the nine real ones. If a
future change makes the suite depend on something only the known tools have, that test
fails and says so — which turns "adding a tool is one module plus one registry line" from
a claim in this document into an assertion.

### 132.11.7 Transport was identity all along (HS-9508)

The HS-9495 backstop found `src/client/agentBackend.ts` holding two `Set`s of tool ids —
a hand-maintained copy of the drive transports, carrying a `⚠ MIRROR` comment that asked
future readers to keep it in step with the server by hand. Nothing pinned it, so adding a
tool server-side silently made the Settings "Auto (currently: X)" hint wrong.

The fix was not to sync the copies but to notice the field was in the wrong place.
**Transport is IDENTITY, not behavior:** "codex speaks MCP+hooks" is a fact about codex,
true whether or not this process can spawn it. It now lives on the plugin — which is
client-safe by the §132.11.1 rule — so `transportFor()` is one definition both sides read.
The server's `resolveAgentTransport` delegates to it; the client's
`deriveDefaultTransport` is now a one-line call; the two `Set`s are gone.

The generalizable question: **when a client "mirror" appears, ask whether the mirrored
field is behavior or identity.** Behavior has to stay server-side and the copy needs a
pin. Identity was simply filed under the wrong concern, and moving it removes the mirror
rather than maintaining it.

`DriveCapability.transport` still exists for server routing, and the conformance suite
now fails if it disagrees with the plugin's — plus a check that the set of tools
declaring a transport is exactly the set with a drive, since either half alone is a bug
(a transport with no drive routes the play button at nothing; a drive whose plugin
declares none makes `transportFor` answer `claude-channel` for a tool we actually spawn).

## 132.12 Cross-references

- [113](113-multi-ai-tool-support.md) — the epic this consolidates; §113.2's A/B tiering
  becomes the plugin `tier` field.
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
- [18](18-plugins.md) — the existing plugin system. AI-tool plugins are a SEPARATE
  interface that reuses its config-UI subsystem (§132.9.2); they do not implement
  `TicketingBackend` and are not loaded by its loader.
- [95](95-settings-sharing-classification.md) — the shared/local layer routing a
  declared preference has to respect (§132.9.2).
- [47](47-richer-permission-overlay.md) — the permission overlay the §132.9.1 toolkit's
  bridge fronts.
