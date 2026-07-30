import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import kerfjs from "eslint-plugin-kerfjs";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tsdoc from "eslint-plugin-tsdoc";
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

// HS-9417 — the rules every file gets. Hoisted so the allowlist blocks below can
// say exactly which subset they want, instead of re-declaring the array (the old
// shape, where each block spelled out its own list, is why adding a rule risked
// silently re-enabling others for allowlisted files).
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

const CORE_RULES = [
  BIND_DISPOSER_RULE,
  ...SPREAD_ARG_LIMIT_RULES,
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
      "no-restricted-syntax": ["error", BIND_DISPOSER_RULE, ...SPREAD_ARG_LIMIT_RULES],
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
      "no-restricted-syntax": ["error", BIND_DISPOSER_RULE, ...SPREAD_ARG_LIMIT_RULES],
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
  // HS-9495 (docs/132) — the tool-id literal rule, plus the files exempt from it. Each
  // exemption has a stated reason; a long allowlist here would mean the rule is wrong.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
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
      // Tests name tools constantly, by necessity.
      "**/*.test.ts",
      "**/*.test.tsx",
      // HS-9508 — the four CLIENT files that re-derive per-tool knowledge, because
      // docs/132 was scoped to the server and the client cannot reach
      // `aiTools/serverCapabilities.ts` (it imports process-spawning modules). Listed
      // INDIVIDUALLY rather than exempting `src/client/**`, so a NEW client tool-id
      // branch still fires. `agentBackend.ts` is the serious one: a second copy of the
      // drive transports with nothing pinning it against the server's.
      "src/client/agentBackend.ts",
      "src/client/codexDriveGate.ts",
      "src/client/commandLogEntryRow.tsx",
      "src/client/settingsDialog.tsx", // HS-9497 deletes this one's branch
    ],
    rules: {
      "no-restricted-syntax": ["error", TOOL_ID_LITERAL_RULE],
    },
  },
);
