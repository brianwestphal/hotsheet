import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import kerfjs from "eslint-plugin-kerfjs";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tsdoc from "eslint-plugin-tsdoc";
import tseslint from "typescript-eslint";

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

// HS-9417 — the rules every file gets. Hoisted so the allowlist blocks below can
// say exactly which subset they want, instead of re-declaring the array (the old
// shape, where each block spelled out its own list, is why adding a rule risked
// silently re-enabling others for allowlisted files).
const CORE_RULES = [
  BIND_DISPOSER_RULE,
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
      "no-restricted-syntax": ["error", BIND_DISPOSER_RULE],
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
      "no-restricted-syntax": ["error", BIND_DISPOSER_RULE],
    },
  },
  // HS-9417 (docs/126 §126.6) — allowlist for the module-level Map/Set rule.
  // Every entry is either genuinely global or ALREADY correctly keyed by project
  // secret; the reason is recorded inline so a future reader doesn't have to
  // re-derive it. Same working model as the §62 innerHTML allowlist: new client
  // modules are NOT on this list, so a net-new unscoped cache gets flagged.
  // Remove a file once its caches move to `projectScoped` (HS-9418).
  //
  // NOTE the deliberate gap: this rule only sees the Map/Set shape, so scalar
  // per-project state (`let lastSeenId = 0` — what most of the docs/125 leaks
  // actually were) is NOT covered here. HS-9419 tracks a custom rule for it.
  {
    files: [
      "src/client/agentBackend.ts", // constant tool-name sets
      "src/client/aiInstructionsNudge.tsx", // Set of secrets — already project-KEYED
      "src/client/analyticsTelemetrySection.tsx", // keyed by (secret, window) — HS-9418 will fold onto projectScoped
      "src/client/announcerPermissionSpeech.ts", // cross-project by design (§78)
      "src/client/bellPoll.tsx", // cross-project by design (§24)
      "src/client/channelUI.tsx", // project-attention Set is keyed by secret
      "src/client/commandLogEntryRow.tsx", // in-flight shell ids — request state, not project data
      "src/client/commandLogStore.ts", // per-entry signals, rebuilt with the list
      "src/client/crossProjectStatsPage.tsx", // cross-project by design (§70)
      "src/client/experimentalSettings.tsx", // icon/color lookup constants
      "src/client/gitStatusChip.tsx", // keyed by secret — HS-9418 will fold onto projectScoped
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
      "src/client/toolPrepNudge.tsx", // Set of secrets — already project-KEYED (HS-9418)
      "src/client/undo/stack.ts", // keyed by secret (HS-9335)
      "src/client/visibilityGroupingsStore.ts", // subscriber disposers, not data
      "src/client/workerPoolPanel.tsx", // in-flight cleanup ids — request state
    ],
    rules: {
      "no-restricted-syntax": ["error", ...CORE_RULES],
    },
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
);
