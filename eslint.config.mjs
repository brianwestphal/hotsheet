import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
import kerfjs from "eslint-plugin-kerfjs";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tsdoc from "eslint-plugin-tsdoc";
import tseslint from "typescript-eslint";

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
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExpressionStatement > CallExpression[callee.name=/^bind(Text|Attr|List)$/]",
          message: "bindText/bindAttr/bindList return a disposer; capture it (or use `void` to mark intentional leak).",
        },
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
      ],
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
      "src/client/commandEditor.tsx",
      "src/client/commandLog.tsx",
      "src/client/commandLogFilter.tsx",
      "src/client/commandSidebar.tsx",
      "src/client/contextMenu.tsx",
      "src/client/customViews.tsx",
      "src/client/dashboard.tsx",
      "src/client/dashboardMode.tsx",
      "src/client/dbRepairUI.tsx",
      "src/client/detail.tsx",
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
      "src/client/settingsCategories.tsx",
      "src/client/settingsDialog.tsx",
      "src/client/settingsLoader.tsx",
      "src/client/tags.tsx",
      "src/client/tagsDialog.tsx",
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
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExpressionStatement > CallExpression[callee.name=/^bind(Text|Attr|List)$/]",
          message: "bindText/bindAttr/bindList return a disposer; capture it (or use `void` to mark intentional leak).",
        },
      ],
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
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExpressionStatement > CallExpression[callee.name=/^bind(Text|Attr|List)$/]",
          message: "bindText/bindAttr/bindList return a disposer; capture it (or use `void` to mark intentional leak).",
        },
      ],
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
);
