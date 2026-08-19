import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import kerfjs from "eslint-plugin-kerfjs";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tsdoc from "eslint-plugin-tsdoc";
import globals from "globals";
import tseslint from "typescript-eslint";

// HS-9419 (docs/126 §126.6) — local rule for the SCALAR half of the
// project-scoped guard. Lives in `eslint-rules/` (plain .mjs, no build step);
// RuleTester coverage sits beside it.
import noUnscopedProjectState from "./eslint-rules/no-unscoped-project-state.mjs";

// HS-9417 — the `no-restricted-syntax` selectors are hoisted so each override
// block can COMPOSE the set it wants instead of re-declaring the array. The old
// shape (three blocks each spelling out their own array) meant adding a fourth
// rule risked silently re-enabling other rules for allowlisted files.
const BIND_DISPOSER_RULE = {
  selector: "ExpressionStatement > CallExpression[callee.name=/^bind(Text|Attr|List)$/]",
  message: "bindText/bindAttr/bindList return a disposer; capture it (or use `void` to mark intentional leak).",
};

// HS-9417 (docs/126 §126.6) — a module-level Map/Set in client code is almost
// always a CACHE, and a cache is either per-project (so it must be
// `projectScoped`, else it leaks the previous project's data across a switch —
// eleven shipped bugs, docs/125) or genuinely global (say so, and allowlist the
// file). Deliberately scoped to this shape: top-level `let` would flag 88 files,
// mostly timers and DOM handles, and a rule that noisy trains reflexive
// allowlisting. **This therefore does NOT cover scalar per-project state** (the
// `let lastSeenId = 0` shape most of the docs/125 leaks actually had) — that gap
// is tracked by HS-9419.
const PROJECT_SCOPED_CACHE_RULE = {
  selector: "Program > VariableDeclaration > VariableDeclarator[init.type='NewExpression'][init.callee.name=/^(Map|Set|WeakMap|WeakSet)$/]",
  message: "Module-level Map/Set in client code: is it PER-PROJECT? If so use `projectScoped(() => new Map(), 'label')` from `src/client/projectScoped.js` — a bare module-level cache leaks the previous project's data across a switch (docs/125; docs/126 §126.2). If it is genuinely global (a constant, a subscriber list, a WeakMap keyed by DOM nodes), add the file to the HS-9417 allowlist in eslint.config.mjs with a one-line reason.",
};

// HS-9455 (HS-9451 root cause) — `f(...arr)` passes every element as a separate
// ARGUMENT, and argument count is bounded by the call stack. Past the bound V8
// throws `RangeError: Maximum call stack size exceeded` — the message runaway
// recursion gives, which is why the real bug (a telemetry day file spread into
// `push`) read as recursion and took three reports to place. Measured on Node
// 22.14/arm64: fine at 100k elements, throws at 125k.
//
// Deliberately NARROW. It fires only when the spread argument is a CALL or an
// `await` — i.e. a value whose size the reader cannot see, which is the shape the
// actual bug had (`push(...await readOtelJsonlDay(...))`). Spreading a named
// constant or a plain identifier (`push(...HEADER_LINES)`) is left alone: a blanket
// rule would flag ~29 sites, nearly all of them bounded, and a rule that gets
// disabled 29 times just teaches people to disable it. Use `pushAll` / `maxOf` /
// `minOf` from `src/utils/largeArray.ts`.
const SPREAD_ARG_LIMIT_RULES = [
  {
    selector: "CallExpression[callee.property.name='push'] > SpreadElement > CallExpression",
    message: "`push(...someCall())` throws RangeError once the array exceeds ~100k elements (HS-9451). Use `pushAll(target, someCall())` from `src/utils/largeArray.ts`.",
  },
  {
    selector: "CallExpression[callee.property.name='push'] > SpreadElement > AwaitExpression",
    message: "`push(...await f())` throws RangeError once the array exceeds ~100k elements — this is exactly the HS-9451 bug. Use `pushAll(target, await f())` from `src/utils/largeArray.ts`.",
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name=/^(max|min)$/] > SpreadElement > CallExpression",
    message: "`Math.max(...someCall())` throws RangeError once the array exceeds ~100k elements (HS-9451). Use `maxOf` / `minOf` from `src/utils/largeArray.ts` (they return null for an empty input rather than ±Infinity).",
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name=/^(max|min)$/] > SpreadElement > AwaitExpression",
    message: "`Math.max(...await f())` throws RangeError once the array exceeds ~100k elements (HS-9451). Use `maxOf` / `minOf` from `src/utils/largeArray.ts`.",
  },
];

// HS-9495 (docs/132 §132.4) — a tool-id string literal outside the plugin layer.
//
// The whole point of docs/132 is that a tool is defined in ONE place. Before it, a
// tool's identity was spelled out across roughly a dozen scattered tables and
// `if (tool === …)` branches — and it got that way one ticket at a time, each addition
// reasonable on its own. This is the backstop that stops it growing back, modelled on
// the §62 `innerHTML` and docs/126 project-scoped rules that exist for the same job.
//
// Deliberately narrow: it flags a literal EQUAL to a tool id, not a substring, so
// `codex_turn`, `dev_tool_codex` and `.codex/hooks.json` paths don't fire. Measured at
// 28 hits over 12 files when written, nearly all in modules named after the tool they
// implement — which the allowlist exempts, because a tool's own module naming itself is
// not the problem this is about.
const TOOL_ID_LITERAL_RULE = {
  selector: "Literal[value=/^(codex|antigravity|opencode|gemini|goose|cursor|copilot|windsurf)$/]",
  message: "Tool-id literal outside `src/aiTools/**`: ask the plugin instead (`getPlugin`, `driveFor`, `skillsCapabilityFor`, … in `src/aiTools/`). A tool is defined in ONE place (docs/132) — scattered ids are exactly what that epic removed. If this file legitimately owns per-tool DATA (the wire enum, the docs/124 gate table) or IS the tool's own module, add it to the HS-9495 allowlist at the bottom of eslint.config.mjs with a one-line reason.",
};

// HS-9510 (following HS-9391) — a synchronous child-process call that cannot be bounded.
//
// `execFileSync` / `execSync` / `spawnSync` block the calling thread inside NATIVE code
// (`SyncProcessRunner::Spawn` → `uv_run`), so a child that never exits is not a slow
// call — it is a thread that never runs again. In a server that is a boot that never
// finishes; in a vitest worker it is the HS-9391 signature, where every test passed but
// no reporter, summary, or even `--reporter=hanging-process` dump could ever run.
//
// TWO properties, because HS-9391 was a call that already had the first one:
// `execFileSync` enforces `timeout` by sending `killSignal`, which DEFAULTS TO SIGTERM —
// and the interactive shell it was killing ignored SIGTERM, so the timeout fired, the
// signal was discarded, and the call blocked forever anyway. A timeout enforced with a
// signal the child may decline is not a timeout. Measured: the stuck shell survived
// SIGTERM, died on SIGKILL, and the held-up run printed its summary instantly.
//
// Test files are exempt (they replace `no-restricted-syntax` with a narrow subset
// below) — a `git init` in a temp fixture repo is not the startup-path risk this is for.
const SYNC_CHILD_PROCESS_RULES = [
  {
    selector: ":matches(CallExpression[callee.name=/^(execFileSync|execSync|spawnSync)$/], CallExpression[callee.property.name=/^(execFileSync|execSync|spawnSync)$/]):not(:has(Property[key.name='timeout']))",
    message: "Synchronous child-process call with no `timeout` (HS-9510). It blocks the thread in native code, so a child that never exits never returns control — on a startup path that is a server that never boots. Add `timeout: <ms>` AND `killSignal: 'SIGKILL'`. If it genuinely cannot block, say why in a comment and add the file to the HS-9510 allowlist at the bottom of eslint.config.mjs.",
  },
  {
    selector: ":matches(CallExpression[callee.name=/^(execFileSync|execSync|spawnSync)$/], CallExpression[callee.property.name=/^(execFileSync|execSync|spawnSync)$/]):not(:has(Property[key.name='killSignal']))",
    message: "Synchronous child-process call with no `killSignal` (HS-9510). `timeout` alone is not enough: it is enforced by sending `killSignal`, which defaults to SIGTERM, and a child that ignores SIGTERM leaves the call blocked forever — that is exactly HS-9391. Add `killSignal: 'SIGKILL'`.",
  },
];

// HS-9527 — the backup modules touch `backupDir`, which the user is EXPECTED to
// point at iCloud Drive / Google Drive / a network share. Those are macOS File
// Provider extensions or network mounts: an operation on them can block for an
// unbounded time with no kernel timeout. A synchronous `fs` call there blocks
// the main event loop until the §45 watchdog SIGKILLs the server — measured at
// 19.9 s for one 29-manifest scan, and the cause of four kills on 2026-07-31.
//
// Scoped to the modules whose whole job is reaching a user-configurable directory.
// Everywhere else `existsSync` on a genuinely local path is fine and this rule
// would be noise.
//
// HS-9570 — `src/routes/attachments.ts` joined the list, and the message below
// lost its claim that `<dataDir>/attachments` is "a genuinely LOCAL path".
// `dataDir` is user-chosen too: a project kept in iCloud / Dropbox / a network
// share puts attachment reads and writes on exactly the same footing as the
// backup dir, on a REQUEST path.
//
// HS-9568 sharpened WHICH calls actually hurt. Measured: `readdir` + a
// per-entry `existsSync` against a Google Drive File Provider root took 0.6 ms,
// because File Provider caches directory METADATA locally. HS-9527's 686 ms was
// a 134 KB content read, which has to be materialized over the network. So the
// hazard is a sync call that must FETCH OR FLUSH BYTES; the selector still
// covers metadata calls because they are cheap to avoid and the distinction is
// easy to get wrong at the call site.
const BACKUP_FS_SYNC_RULE = {
  selector:
    "CallExpression[callee.name=/^(existsSync|readFileSync|writeFileSync|readdirSync|statSync|lstatSync|rmSync|mkdirSync|renameSync|copyFileSync|linkSync|unlinkSync|rmdirSync|appendFileSync|accessSync|openSync|cpSync)$/]",
  message:
    "Synchronous `fs` in a backup module (HS-9527). `backupDir` is commonly a cloud/network folder where a sync call can block the event loop indefinitely — this is what wedged the server four times on 2026-07-31. Use the guarded async layer in `src/backupFs.ts` (`backupFsFor(root)`), which adds a deadline, a threadpool concurrency cap, and a circuit breaker. The same applies to `dataDir` — it is user-chosen, so attachments can sit on a cloud mount too (HS-9570). Reads/writes of file CONTENTS are the dangerous ones (they must materialize bytes over the network); prefer streaming for whole files. For a path that genuinely cannot be remote, use `fs.promises` and say why in a comment.",
};

// HS-9541 — an event listener with an EMPTY body. This is the residue of a deleted
// call: HS-9515 removed `applyAiToolDevGating`, took the call out of the
// DEV_FEATURES_CHANGED_EVENT handler in `settingsDialog.tsx`, and left
// `document.addEventListener(EVENT, () => {})` behind. That undid HS-9474's fix, and
// the symptom came back wider — ticking Settings → Experimental → "Unreleased AI
// tools" refreshed neither the picker nor the enable list, so the tools it revealed
// never appeared. Nothing caught it: an empty handler type-checks, lints, and reads
// as deliberate.
//
// Deliberately narrow. The generic `no-empty-function` matches 93 sites here (mostly
// no-op defaults and `catch {}`-style stubs) and would be pure noise; a registered
// listener that does nothing is a different claim — it says "this event is handled"
// while handling nothing. Zero occurrences at introduction. If you genuinely want a
// no-op subscriber (holding a passive listener open, say), give it a body comment
// explaining why and disable this line.
const EMPTY_LISTENER_RULE = {
  selector:
    "CallExpression[callee.property.name='addEventListener'] > :matches(ArrowFunctionExpression, FunctionExpression)[body.type='BlockStatement'][body.body.length=0]",
  message:
    "Event listener with an empty body (HS-9541). A registered handler that does nothing claims the event is handled while handling nothing — this is what silently reverted HS-9474 when HS-9515 deleted the call inside it. Either restore the work the handler should do, or delete the `addEventListener` entirely.",
};

// HS-9417 — the rules every file gets. Hoisted so the allowlist blocks below can
// say exactly which subset they want, instead of re-declaring the array (the old
// shape, where each block spelled out its own list, is why adding a rule risked
// silently re-enabling others for allowlisted files).

const CORE_RULES = [
  BIND_DISPOSER_RULE,
  EMPTY_LISTENER_RULE,
  ...SPREAD_ARG_LIMIT_RULES,
  ...SYNC_CHILD_PROCESS_RULES,
  // HS-9495 — the tool-id rule COMPOSES here rather than living in a trailing
  // `files: ["src/**"]` block. That trailing shape is what caused HS-9518: flat
  // config REPLACES a rule's options rather than merging them, so a last block
  // saying `"no-restricted-syntax": ["error", TOOL_ID_LITERAL_RULE]` silently
  // switched off every other selector in this file for all of `src/**` — the
  // sync-child-process guard, the spread-arg guard, innerHTML, JSON.parse-as,
  // bind-disposer. Composing it here means a new core rule reaches every block
  // automatically, which is the same reasoning as the HS-9417 note above.
  // Exemptions are a SUBTRACT block at the bottom (`TOOL_ID_EXEMPT_FILES`).
  TOOL_ID_LITERAL_RULE,
  {
    selector: "AssignmentExpression[operator='='] > MemberExpression.left[property.name='innerHTML'][computed=false]",
    message: "Direct `innerHTML = ` assignments bypass the kerf-routed `toElement` parser path (HS-8241 / §62) and lose the SVG-namespace + entity-handling fixes. Use `el.replaceChildren(toElement(<jsx />))` instead, or `el.replaceChildren(toElement(<span>{raw(htmlString)}</span>))` for raw-HTML escape hatches. (HS-8243 / §62.6 Phase 3.)",
  },
  // HS-8567 — `JSON.parse(...) as X` silently asserts the parsed
  // shape without checking it (the exact failure mode that hid
  // HS-8562 — `kerfToElement(...) as HTMLElement` from the kerfjs
  // 0.12.0 return-type widening). Use the zod helpers in
  // `src/schemas.ts` instead: `parseJsonOrNull(MySchema, raw)`
  // for tolerant parsing, `parseJson(MySchema, raw, 'context')`
  // for throw-on-failure. Exception: `as unknown` (intentional
  // erasure prior to a follow-up shape check) is still allowed.
  {
    selector: "TSAsExpression[expression.type='CallExpression'][expression.callee.object.name='JSON'][expression.callee.property.name='parse']:not([typeAnnotation.type='TSUnknownKeyword'])",
    message: "`JSON.parse(x) as Y` skips runtime validation. Use `parseJson(YSchema, x)` / `parseJsonOrNull(YSchema, x)` from `src/schemas.ts` instead, or assign to `const raw: unknown = JSON.parse(x)` then narrow with a zod `safeParse`. (HS-8567.)",
  },
  // HS-8567 — `await res.json() as X` silently asserts the wire
  // response shape. Use the `schema` parameter on the
  // `src/client/api.tsx` helpers (`api<T>(path, { schema })`) or
  // for raw fetch calls, do `const raw: unknown = await
  // res.json()` then `MySchema.safeParse(raw)`.
  {
    selector: "TSAsExpression[expression.type='CallExpression'][expression.callee.property.name='json']:not([typeAnnotation.type='TSUnknownKeyword'])",
    message: "`res.json() as Y` skips wire-boundary validation. Use the zod `schema` parameter on the `src/client/api.tsx` helpers, or `const raw: unknown = await res.json()` + `MySchema.safeParse(raw)`. (HS-8567.)",
  },
  {
    selector: "TSAsExpression[expression.type='AwaitExpression'][expression.argument.type='CallExpression'][expression.argument.callee.property.name='json']:not([typeAnnotation.type='TSUnknownKeyword'])",
    message: "`await res.json() as Y` skips wire-boundary validation. Use the zod `schema` parameter on the `src/client/api.tsx` helpers, or `const raw: unknown = await res.json()` + `MySchema.safeParse(raw)`. (HS-8567.)",
  },
];

/**
 * HS-9533 — the `e2e/` subsets, derived from CORE_RULES by subtraction.
 *
 * Matching on selector text rather than object identity because these selectors
 * are declared inline in the array above; the alternative is naming five more
 * consts purely so this file can point at them.
 */
const isInnerHtmlRule = (r) => r.selector.includes("'innerHTML'");
const isResJsonRule = (r) => r.selector.includes("callee.property.name='json'");

/** e2e helpers: everything except the two that are about our renderer / tool layer. */
const E2E_HELPER_RULES = CORE_RULES.filter(
  (r) => r !== TOOL_ID_LITERAL_RULE && !isInnerHtmlRule(r),
);

/** e2e specs: the above, minus the wire-boundary pair. `JSON.parse(x) as Y` is
 *  deliberately KEPT — parsing a file the test wrote is a real trust boundary,
 *  unlike asserting on a response from the server under test. */
const E2E_SPEC_RULES = E2E_HELPER_RULES.filter((r) => !isResJsonRule(r));

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "scripts/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
      import: importX,
      tsdoc: tsdoc,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true, allow: [{ from: "file", name: "SafeHtml" }, { from: "lib", name: "URLSearchParams" }] }],
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // HS-8093 — allow `_`-prefixed args / vars / caught-errors as the
      // documented "intentionally unused" convention. Pre-fix the rule
      // was using its tseslint default which doesn't honour the prefix,
      // so callsites that wanted to keep a parameter for documentation
      // (e.g. `_signal`, `_secret`, `_terminalId`) tripped lint despite
      // the convention being self-documenting.
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-duplicates": "error",
      "tsdoc/syntax": "warn",
      // HS-8235 / §60.6 — `bindText` / `bindAttr` / `bindList` return a
      // disposer that MUST be captured. A top-level call expression
      // (CallExpression as a direct child of ExpressionStatement) means
      // the disposer was discarded — the effect will keep firing against
      // a detached node forever. Assign to a const, push onto a disposer
      // list, or — for the rare deliberately-leaked case — wrap with
      // `void bindText(...)` which becomes a UnaryExpression and bypasses
      // this rule.
      //
      // HS-8243 / §62 Phase 3 — direct `xxx.innerHTML = yyy` assignments
      // bypass the kerf-routed `toElement` parser path (see HS-8241), so
      // SVG-namespace / entity / custom-attr divergences slip back in.
      // New code should use `el.replaceChildren(toElement(<jsx />))` or
      // `el.replaceChildren(toElement(<span>{raw(htmlString)}</span>))`
      // instead. Existing 35 client files (~93 callsites) are exempted
      // via the file-path allowlist override below — flag-and-fix when
      // those files are touched, no flag-day refactor required. Allowed
      // exceptions inside the allowlisted files are documented in the
      // override config block.
      "no-restricted-syntax": ["error", ...CORE_RULES],
    },
  },
  // HS-9417 (docs/126 §126.6) — the module-level Map/Set rule applies to CLIENT
  // code only: it is about per-project UI state surviving a project switch, which
  // is a client concern (the server handles one project per request).
  {
    files: ["src/client/**/*.ts", "src/client/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...CORE_RULES, PROJECT_SCOPED_CACHE_RULE],
    },
  },
  // HS-9538 — the HS-9417 allowlist: client modules whose module-level Map/Set is
  // genuinely global, not per-project. Composed as CORE_RULES minus the
  // project-scoped selector, never as a hand-written shorter list (HS-9518).
  //
  //   morphAudit.ts — measures RENDER behavior, not project data. Its `WeakMap` is
  //   keyed by DOM nodes (a case the rule's own message names as legitimately
  //   global), and its counters are deliberately NOT reset on a project switch:
  //   redundant re-renders across a switch are exactly what you want to see.
  //
  //   markdownCache.ts (HS-9539) — keyed by the markdown TEXT, and holds no project
  //   data: the same text renders to the same HTML in every project, so a hit across
  //   a project switch is correct rather than stale. Bounded by MARKDOWN_CACHE_MAX.
  {
    files: ["src/client/morphAudit.ts", "src/client/markdownCache.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...CORE_RULES],
    },
  },
  // HS-8243 — file-path allowlist for the 35 production client files
  // that already use `xxx.innerHTML = ` (~93 callsites total) PLUS
  // every test file (where `document.body.innerHTML = '<...>'` is the
  // standard happy-dom setup pattern and migrating to `replaceChildren`
  // would just be noise). Re-defines the `no-restricted-syntax` rule
  // for these files WITHOUT the innerHTML selector so existing code
  // keeps lint-passing; the bind* disposer selector stays in force
  // everywhere. Per the HS-8243 reduced scope (option 4 from the
  // ticket's notes): flag NEW innerHTML across the codebase, fix
  // existing instances opportunistically when those files are touched.
  // Adding a NEW innerHTML assignment in a production file on this
  // list will still slip through; remove the file from the list once
  // its existing usages migrate so it gets full protection. A
  // production file NOT on this list (including any new client module)
  // gets the rule applied — the safety net for net-new code.
  {
    files: [
      // Production client files with existing innerHTML usage.
      "src/client/backups.tsx",
      // HS-8554 — `src/client/channelUI.tsx` migrated (two `innerHTML =
      // '✓ …'` swapped to `textContent`). Removed from allowlist so
      // new innerHTML assignments in this file get caught by the lint
      // rule.
      "src/client/clipboardUtil.tsx",
      // HS-8365 — `src/client/columnView.tsx` migrated, removed from allowlist.
      // HS-8614 — `src/client/commandEditor.tsx` migrated
      // (`renderCustomCommandSettings` `innerHTML = ''` + the per-row
      // listeners replaced by `replaceChildren` + delegated handlers), removed
      // from allowlist.
      "src/client/commandLog.tsx",
      "src/client/commandLogFilter.tsx",
      "src/client/commandSidebar.tsx",
      "src/client/contextMenu.tsx",
      "src/client/customViews.tsx",
      "src/client/dashboard.tsx",
      "src/client/dashboardMode.tsx",
      "src/client/dbRepairUI.tsx",
      // HS-8677 — `src/client/detail.tsx` migrated (4 non-empty JSX assignments
      // + 1 raw-HTML linkified-markdown to `morph()`; 5 empty clears to
      // `replaceChildren()`), removed from allowlist.
      "src/client/drawerTerminalGrid.tsx",
      // HS-8365 — `src/client/feedbackDialog.tsx` migrated, removed from allowlist.
      "src/client/iconPicker.tsx",
      // HS-8365 — `src/client/noteRenderer.tsx` migrated, removed from allowlist.
      "src/client/openFolder.tsx",
      "src/client/permissionDialogShell.tsx",
      "src/client/pluginConfigDialog.tsx",
      // HS-8554 — `src/client/pluginSettings.tsx` migrated (three
      // empty-state `innerHTML =` blocks swapped to
      // `replaceChildren(toElement(<div className="plugin-empty-message">
      // …</div>))` + the new `.plugin-empty-message` SCSS class).
      // Removed from allowlist so new innerHTML assignments in this
      // file get caught by the lint rule.
      "src/client/pluginUI.tsx",
      "src/client/projectTabs.tsx",
      // HS-8365 — `src/client/readerOverlay.tsx` migrated, removed from allowlist.
      // HS-8614 — `src/client/settingsCategories.tsx` migrated (the
      // `renderCategoryList` `innerHTML = ''` + per-row listeners replaced by a
      // single `replaceChildren` + delegated handlers), removed from allowlist.
      "src/client/settingsDialog.tsx",
      "src/client/settingsLoader.tsx",
      "src/client/tags.tsx",
      // HS-8614 — `src/client/tagsDialog.tsx` migrated (`renderTagRows`
      // `innerHTML = ''` + per-checkbox `change` listener replaced by a single
      // `replaceChildren` + one delegated `change` handler), removed from
      // allowlist.
      // HS-8448 — `src/client/terminal.tsx` + `src/client/terminalDashboard.tsx`
      // no longer contain any `innerHTML =` assignments (migrated incrementally
      // under HS-8365 / §54), removed from the allowlist so new innerHTML
      // assignments in these files get caught by the lint rule.
      "src/client/terminalDefaultAppearanceUI.tsx",
      // HS-8365 — `src/client/terminalsSettings.tsx` retains popover-rebuild
      // innerHTML usage (HS-8365 non-target — popover dismisses on focus loss,
      // morph doesn't help) so stays on the allowlist.
      "src/client/terminalsSettings.tsx",
      // HS-8365 — `src/client/ticketList.tsx` retains one icon-swap innerHTML
      // (star-mixed-wrap, line 453 — non-target per the HS-8365 "icon swaps"
      // callout) so stays on the allowlist.
      "src/client/ticketList.tsx",
      // Tests legitimately use `document.body.innerHTML = '<...>'` to
      // build the test DOM under happy-dom. The HS-8243 rule's intent
      // is to protect the kerf-routed `toElement` parser path in
      // production client code, not to police test scaffolding.
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      // HS-9417 — deliberately NOT adding the module-level Map/Set rule here.
      // Several of these files have existing caches that would need allowlisting
      // too, and a file in BOTH allowlists would hit flat-config's later-wins
      // merge and silently get innerHTML re-enabled. Keeping the two lists
      // DISJOINT is what makes the composition above safe. These files pick the
      // rule up as they graduate off the innerHTML list.
      // HS-9455 — the spread-argument-limit rules DO apply here. This allowlist is
      // about `innerHTML`, and narrowing to `BIND_DISPOSER_RULE` alone would have
      // silently switched them off for ~35 client files — the same "adding a rule
      // doesn't reach the override blocks" trap the HS-9417 note at the top warns
      // about, in the opposite direction.
      // HS-9511 — the sync child-process rules apply here for the same reason.
      // HS-9518 — and the tool-id rule, for a third time the same reason: this
      // allowlist is about `innerHTML`, so anything else it drops is dropped by
      // accident. The three files this rule genuinely exempts are subtracted in
      // the HS-9495 block at the bottom.
      "no-restricted-syntax": ["error", BIND_DISPOSER_RULE, ...SPREAD_ARG_LIMIT_RULES, ...SYNC_CHILD_PROCESS_RULES, TOOL_ID_LITERAL_RULE],
    },
  },
  // HS-8567 — test files are exempt from the wire-/file-boundary
  // rules. Tests legitimately construct fixture-shaped values via
  // `JSON.parse(x) as TestFixture` to assert against a known shape;
  // adding zod scaffolding around every assertion would be noise. The
  // rules above stay in force everywhere else. (innerHTML allowlist
  // already covers tests via the `**/*.test.{ts,tsx}` glob; this block
  // is parallel.)
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      // HS-9455 — spread-argument-limit rules stay on in tests too: a test is where
      // you are most likely to build a large fixture array and hit the limit.
      // HS-9511 — and the sync child-process rules stay on in tests too. HS-9391's
      // entire SYMPTOM was a wedged test suite: a sync spawn blocks the worker thread
      // in native code, so every test passes and then no reporter, summary, or
      // `hanging-process` dump can run. A wedge is also HARDER to diagnose from a
      // test than from production code, because the natural first assumption is that
      // the test is merely slow. Tests are where this rule earns the most, not least.
      "no-restricted-syntax": ["error", BIND_DISPOSER_RULE, ...SPREAD_ARG_LIMIT_RULES, ...SYNC_CHILD_PROCESS_RULES],
    },
  },
  // HS-9417 (docs/126 §126.6) — allowlist for the module-level Map/Set rule.
  // Every entry is either genuinely global or ALREADY correctly keyed by project
  // secret; the reason is recorded inline so a future reader doesn't have to
  // re-derive it. Same working model as the §62 innerHTML allowlist: new client
  // modules are NOT on this list, so a net-new unscoped cache gets flagged.
  // Remove a file once its caches move to `projectScoped` (HS-9418) — three have
  // already graduated this way (gitStatusChip, analyticsTelemetrySection,
  // toolPrepNudge), which is the intended lifecycle for this list.
  //
  // `dashboardMode.tsx` is NOT a graduation candidate: its cost cache is written
  // for EVERY project at once from a bulk response and read for the active one,
  // which `projectScoped.set()` (active cell only) cannot express. See docs/126
  // §126.7.
  //
  // NOTE the deliberate gap: this rule only sees the Map/Set shape, so scalar
  // per-project state (`let lastSeenId = 0` — what most of the docs/125 leaks
  // actually were) is NOT covered here. HS-9419 tracks a custom rule for it.
  {
    files: [
      "src/client/agentBackend.ts", // constant tool-name sets
      "src/client/aiInstructionsNudge.tsx", // Set of secrets — already project-KEYED
      "src/client/announcerPermissionSpeech.ts", // cross-project by design (§78)
      // HS-9418 — these two GRADUATED their data caches onto `projectScoped`; what
      // remains is genuinely global, so they stay listed for a narrower reason. That
      // is the normal end state: an entry usually shrinks in scope rather than
      // disappearing.
      "src/client/analyticsTelemetrySection.tsx", // only `lastPaintedAnalyticsFor` left — a WeakMap keyed by DOM nodes (paint state, docs/126 §126.5)
      "src/client/gitStatusChip.tsx", // only `inFlightByKey` left — in-flight request promises for coalescing, not data
      "src/client/bellPoll.tsx", // cross-project by design (§24)
      "src/client/channelUI.tsx", // project-attention Set is keyed by secret
      "src/client/commandLogEntryRow.tsx", // in-flight shell ids — request state, not project data
      "src/client/commandLogStore.ts", // per-entry signals, rebuilt with the list
      "src/client/crossProjectStatsPage.tsx", // cross-project by design (§70)
      "src/client/experimentalSettings.tsx", // icon/color lookup constants
      "src/client/noteRenderer.tsx", // markdown render constants
      "src/client/dropdown.tsx", // KERF-EVAL — transient open-overlay handles (kerf popover), not project data; closed on navigation via closeAllMenus
      "src/client/serverBusyChip.tsx", // global in-flight request set
      "src/client/settingsScope.tsx", // constant tab-name Set
      "src/client/state.tsx", // THE per-project session store itself (projectViews/Searches/…), keyed by secret
      "src/client/terminalAppearance.ts", // keyed by terminal id, not project
      "src/client/terminalCheckout.tsx", // xterm stack keyed by terminal id; torn down by onProjectSwitch
      "src/client/terminalFonts.ts", // global font-load cache (machine-level)
      "src/client/terminalSearch.tsx", // WeakMaps keyed by xterm instances
      "src/client/terminalTransientNames.ts", // keyed by terminal id
      "src/client/ticketsStore.ts", // store internals, replaced wholesale on load
      "src/client/undo/stack.ts", // keyed by secret (HS-9335)
      "src/client/visibilityGroupingsStore.ts", // subscriber disposers, not data
      "src/client/workerPoolPanel.tsx", // in-flight cleanup ids — request state
    ],
    rules: {
      "no-restricted-syntax": ["error", ...CORE_RULES],
    },
  },
  // HS-9419 (docs/126 §126.6) — the scalar counterpart to PROJECT_SCOPED_CACHE_RULE.
  // Reported at **warn**, deliberately: after the H1 (file fetches project data) +
  // H3 (skip timers/DOM/disposers) heuristics the set is still 99 declarations
  // across 45 files, and it legitimately contains one-time init flags
  // (`let wired = false`) that no heuristic can tell from per-project data. An
  // error rule at that precision gets allowlisted reflexively, and then the
  // allowlist stops being read — worse than no rule. Promote to error only if the
  // seeded list below is worked down far enough that the remainder is trustworthy.
  {
    files: ["src/client/**/*.ts", "src/client/**/*.tsx"],
    plugins: { hotsheet: { rules: { "no-unscoped-project-state": noUnscopedProjectState } } },
    rules: { "hotsheet/no-unscoped-project-state": "warn" },
  },
  // HS-9419 — seeded from the files that already had module-level scalars when the
  // rule landed, so it is SILENT on existing code and speaks only for net-new
  // modules (same working model as the innerHTML + cache allowlists). Remove a file
  // once its per-project scalars move to `projectScoped`; several entries here are
  // genuine suspects rather than false positives — see HS-9420.
  {
    files: [
      "src/client/addRemoteServerDialog.tsx",
      "src/client/analyticsTelemetrySection.tsx",
      "src/client/announcerPermissionPref.ts",
      "src/client/announcerPip.tsx",
      "src/client/announcerSpeechRate.ts",
      "src/client/bellPoll.tsx",
      "src/client/commandLog.tsx",
      "src/client/crossProjectStatsButton.tsx",
      "src/client/crossProjectStatsPage.tsx",
      "src/client/customViews.tsx",
      "src/client/dashboard.tsx",
      "src/client/detail.tsx",
      "src/client/devicesPairing.tsx",
      "src/client/draftRow.tsx",
      "src/client/experimentalSettings.tsx",
      "src/client/feedbackDialog.tsx",
      "src/client/gitStatusChip.tsx",
      "src/client/globalDiagnostics.ts",
      "src/client/inflightPanel.tsx",
      "src/client/noteRenderer.tsx",
      "src/client/permissionOverlay.tsx",
      "src/client/permissionPopupStateMachine.ts",
      "src/client/persistedHiddenTerminals.ts",
      "src/client/pluginUI.tsx",
      "src/client/poll.tsx",
      "src/client/projectTabs.tsx",
      "src/client/reviewProofSection.tsx",
      "src/client/settingsDialog.tsx",
      "src/client/settingsLoader.tsx",
      "src/client/settingsScope.tsx",
      "src/client/share.tsx",
      "src/client/telemetryCostMode.ts",
      "src/client/terminalAppearancePopover.tsx",
      "src/client/terminalDashboardLayout.ts",
      "src/client/terminalDashboardSlider.ts",
      "src/client/terminalDefaultAppearanceUI.tsx",
      "src/client/terminalInstanceLifecycle.tsx",
      "src/client/terminalTabDragDrop.ts",
      "src/client/terminalWebgl.ts",
      "src/client/terminalsSettings.tsx",
      "src/client/ticketList.tsx",
      "src/client/ticketRefs.ts",
      "src/client/ticketTelemetryStats.tsx",
      "src/client/undo/actions.ts",
      "src/client/workerAutoMode.ts",
      "src/client/workerPoolPanel.tsx",
    ],
    rules: { "hotsheet/no-unscoped-project-state": "off" },
  },
  // HS-9419 — test files are exempt, matching the innerHTML + wire-boundary rules.
  // A spec legitimately holds fixture state at module level (`let layered = …`
  // rebuilt in `beforeEach`); there is no project switch in a unit test for it to
  // leak across.
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "hotsheet/no-unscoped-project-state": "off" },
  },
  // HS-8466 — `eslint-plugin-kerfjs` recommended preset (flat config).
  // Adds the four kerf AST rules at `error` severity:
  //   - `kerfjs/no-inline-jsx-event-handlers` (Hard Rule 9)
  //   - `kerfjs/require-data-key-in-each` (Hard Rule 2)
  //   - `kerfjs/no-nested-mount` (Hard Rule 5)
  //   - `kerfjs/prefer-module-jsx-augmentation` (Hard Rule 11)
  // Complements the project-local `no-restricted-syntax` rules above
  // (`bindText`/`bindAttr`/`bindList` disposer capture + the §62.6
  // Phase 3 `innerHTML` ban). Placed last so the kerf rules apply to
  // all files including the allowlisted ones — the allowlist above
  // only narrows `no-restricted-syntax`, not the kerf rules.
  kerfjs.configs.recommended,
  // HS-9255 — `eslint-plugin-kerfjs` 0.16.0 added `kerfjs/ai-assistant-configs`
  // to the recommended preset. Unusually for a lint rule, its `fix()` WRITES the
  // kerf-app Claude skill / Cursor rules to disk (`.claude/skills/kerf-app/
  // SKILL.md` etc.) — and ESLint evaluates a reported fix even without `--fix`,
  // so `npm run lint` (`eslint src/`) mutates files as a side effect. That's
  // wrong for a gate (a lint run shouldn't edit the repo) and it hard-errors
  // here because `.claude/skills` is auto-generated + write-denied. Disable it;
  // the four kerf AST hard-rules from the preset stay on. The skill file is
  // regenerated by its own tooling, not the lint gate.
  {
    rules: {
      "kerfjs/ai-assistant-configs": "off",
    },
  },
  // HS-9495 (docs/132) — files EXEMPT from the tool-id literal rule. Each exemption
  // has a stated reason; a long allowlist here would mean the rule is wrong.
  //
  // HS-9518 — this is a SUBTRACT block: the rule itself now composes in
  // `CORE_RULES`, and these files re-declare the same set MINUS the tool-id
  // selector. It used to be the inverse — a trailing `files: ["src/**"]` block
  // whose rules array held ONLY the tool-id rule. Flat config replaces a rule's
  // options rather than merging them, so being last made that block the final
  // word for every file under `src/`, silently disabling the sync-child-process,
  // spread-arg, innerHTML, JSON.parse-as and bind-disposer selectors across the
  // whole tree. Nothing failed loudly; the guards just stopped existing. Adding a
  // rule to a shared array must never turn other rules off — express exemptions
  // by subtracting, never by re-declaring a shorter list.
  {
    files: [
      // THE plugin layer — where per-tool knowledge is supposed to live.
      "src/aiTools/**",
      // A tool's OWN implementation module naming itself is not the leak this targets;
      // the rule is about ids reaching GENERIC code.
      "src/codex*.ts",
      "src/antigravity*.ts",
      "src/acp/**",
      "src/terminals/codexHostedWarning.ts",
      // Per-tool DATA that legitimately lives outside the registry — both pinned against
      // it by the conformance suite, so the two cannot drift:
      "src/api/aiInstructions.ts", // the wire enum: a literal `as const` tuple by design (§132.5)
      "src/devFeatures.ts",        // the docs/124 In-Development gate table
      "src/channelWarmClient.ts",  // HS-9629 — the codex MCP `clientInfo.name` signature; the lean channel-server bundle can't reach the aiTools registry
      // NOTE: tests name tools constantly and are exempt too, but they get that from
      // their OWN block above (which spells out a subset that never included the
      // tool-id rule) — listing them here as well would hand them this block's array
      // instead, re-enabling the wire-boundary rules tests are deliberately exempt from.
      // HS-9508 — the four CLIENT files that re-derive per-tool knowledge, because
      // docs/132 was scoped to the server and the client cannot reach
      // `aiTools/serverCapabilities.ts` (it imports process-spawning modules). Listed
      // INDIVIDUALLY rather than exempting `src/client/**`, so a NEW client tool-id
      // branch still fires. `agentBackend.ts` came OFF this list in HS-9508 — its copy of
      // the transport table is gone, replaced by the client-safe `transportFor`.
      "src/client/codexDriveGate.ts",
      "src/client/commandLogEntryRow.tsx",
    ],
    ignores: [
      // Tests reach their exemption through their OWN block above; letting this
      // one match them would hand them CORE_RULES and re-enable the wire-boundary
      // selectors they are deliberately exempt from (12 hits when this block was
      // first written without the guard — `src/acp/**`, `src/aiTools/**` and
      // `src/codex*.ts` all have `.test.ts` files that match those globs).
      "**/*.test.ts",
      "**/*.test.tsx",
      // On the §62 innerHTML allowlist as well, so it needs THAT array minus the
      // tool-id rule, not CORE_RULES minus it. Handled by the block below.
      "src/client/settingsDialog.tsx",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...CORE_RULES.filter((r) => r !== TOOL_ID_LITERAL_RULE)],
    },
  },
  // HS-9518 — the one file on BOTH the §62 innerHTML allowlist and the HS-9495
  // tool-id exemption. It needs the innerHTML-allowlist array minus the tool-id
  // rule; using CORE_RULES here would re-enable innerHTML for it. The comment on
  // the innerHTML allowlist notes the two lists are kept DISJOINT for exactly this
  // reason — this is the single overlap, so it gets its own block rather than
  // silently picking up whichever array happened to come last.
  {
    files: ["src/client/settingsDialog.tsx"],
    rules: {
      "no-restricted-syntax": ["error", BIND_DISPOSER_RULE, ...SPREAD_ARG_LIMIT_RULES, ...SYNC_CHILD_PROCESS_RULES],
    },
  },
  // HS-9527 — the backup modules get CORE_RULES **plus** the sync-fs ban. Written
  // as a compose (`...CORE_RULES, BACKUP_FS_SYNC_RULE`) rather than a trailing
  // block that lists only the new rule: flat config REPLACES a rule's options,
  // and a block naming just this selector would switch every other guard off for
  // these files. That is precisely the HS-9518 regression.
  //
  // Test files are included. The whole point is that a sync call here is
  // invisible in development — it is fast against a local temp dir and only
  // wedges against the user's real cloud folder — so a test is exactly where an
  // unguarded call would be written and never noticed.
  {
    files: ["src/backup.ts", "src/backupFs.ts", "src/attachmentBackup.ts", "src/strandedBackups.ts", "src/routes/attachments.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...CORE_RULES, BACKUP_FS_SYNC_RULE],
    },
  },
  // HS-9523 — plain `.mjs` (this file, `eslint-rules/*.mjs`) belongs to no
  // TypeScript project, so the type-aware parser cannot resolve it and every such
  // file reported a parse error instead of being linted. Type-aware rules do not
  // apply to untyped JS anyway; this turns them off for `.mjs` so the syntactic
  // rules — which DO apply — can finally run on our own ESLint rule sources.
  //
  // Only type-aware rules are disabled. `no-restricted-syntax` and the rest of
  // the syntactic set are untouched, so this cannot repeat the HS-9518 wipeout.
  // HS-9533 — which CORE_RULES apply to a Playwright spec.
  //
  // `e2e/` used to belong to no tsconfig, so ESLint could not parse it and linted
  // NONE of it. HS-9523 gave it one, which exposed 664 errors — and the shape of
  // them turned out to be the opposite of what was assumed. It is not `innerHTML`
  // (8 hits); it is the wire-boundary rule, at 352.
  //
  // Maintainer direction was to optimize for DEFENSIVE CODING, so the default here
  // is to keep a guard unless it is inapplicable — not unless it is inconvenient.
  // Three are subtracted, each for a reason about the code rather than the count:
  //
  //  * **innerHTML (§62)** — all 8 sites are inside `page.evaluate`, i.e. the
  //    BROWSER context, building DOM fixtures. `toElement` does not exist there,
  //    and the rule's whole rationale (kerf's parser path, SVG namespacing, entity
  //    handling) is about our renderer, which is not involved.
  //  * **Tool-id literal (HS-9495)** — a spec naming 'codex' is per-tool TEST DATA
  //    (picking an option in a dropdown), not a tool-id BRANCH outside the plugin
  //    layer. docs/132's rule already contemplates this: its allowlist exempts
  //    files that legitimately own per-tool data.
  //  * **Wire-boundary (HS-8567) — in `*.spec.ts` ONLY.** Kept everywhere else.
  //    In production the rule guards against an upstream shape change shipping a
  //    crash. In a spec the "upstream" is the server under test, and a cast that
  //    goes stale makes the test FAIL — which is the outcome you want. Rewriting
  //    356 inline shapes into schemas would add real risk (an over-strict schema
  //    broke 9 plugin tests during HS-9523) for very little safety.
  //
  // The rule still applies to e2e HELPERS, where the reasoning inverts: a wrong
  // shape in `coverage-fixture.ts` propagates into every spec that uses it instead
  // of failing one assertion locally.
  //
  // Everything else stays ON, including the sync-child-process guard — HS-9511
  // already extended that to unit tests, and a wedged E2E suite is the exact
  // symptom HS-9391 presented with.
  //
  // Composed by SUBTRACTING from CORE_RULES, never by re-declaring a shorter list:
  // flat config replaces a rule's options, so a hand-written subset would silently
  // drop any guard added to CORE_RULES later. That is the HS-9518 regression.
  {
    files: ["e2e/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...E2E_HELPER_RULES],
    },
  },
  {
    files: ["e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...E2E_SPEC_RULES],
    },
  },
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Spread the disable-type-checked languageOptions FIRST. Writing this key at
      // all replaces the one the spread above provides, and that is what turns the
      // type-aware parser off — dropping it puts the parse errors straight back.
      ...tseslint.configs.disableTypeChecked.languageOptions,
      // Explicit rather than inherited: these files belong to no tsconfig, which is
      // the whole reason the project service could not parse them.
      parserOptions: { projectService: false, project: false },
      // They run under Node as ESM. Without the globals, `no-undef` reports `URL`,
      // `process` and friends as undefined identifiers.
      globals: { ...globals.node },
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
);
