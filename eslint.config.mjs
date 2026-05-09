import eslint from "@eslint/js";
import importX from "eslint-plugin-import-x";
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
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExpressionStatement > CallExpression[callee.name=/^bind(Text|Attr|List)$/]",
          message: "bindText/bindAttr/bindList return a disposer; capture it (or use `void` to mark intentional leak).",
        },
      ],
    },
  },
);
