/**
 * HS-9419 — RuleTester coverage for `hotsheet/no-unscoped-project-state`.
 *
 * A lint rule is code, and an unverified lint rule is worse than none: a
 * false-negative silently removes the protection everyone assumes is there, and
 * a false-positive trains reflexive allowlisting. Both heuristics (H1 = the file
 * imports the project API, H3 = infrastructure shapes are skipped) are pinned
 * here, in both directions.
 */
import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';

import rule from './no-unscoped-project-state.mjs';

// RuleTester speaks describe/it; hand it vitest's.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
});

const API_IMPORT = "import { getTickets } from '../api/index.js';\n";

ruleTester.run('no-unscoped-project-state', rule, {
  valid: [
    // H1 — a module that never fetches project data has nothing to leak.
    { code: "let lastSeenId = 0;" },
    { code: "import { foo } from './util.js';\nlet lastSeenId = 0;" },

    // `const` is not mutable state (the Map/Set case is the sibling rule's job).
    { code: `${API_IMPORT}const LIMIT = 10;` },

    // Function-scoped `let` is per-call, not per-module.
    { code: `${API_IMPORT}function f() { let x = 0; return x; }` },

    // H3 — infrastructure by TYPE.
    { code: `${API_IMPORT}let t: ReturnType<typeof setInterval> | null = null;` },
    { code: `${API_IMPORT}let el: HTMLElement | null = null;` },
    { code: `${API_IMPORT}let obs: IntersectionObserver | null = null;` },
    { code: `${API_IMPORT}let sock: WebSocket | null = null;` },
    { code: `${API_IMPORT}let inflight: Promise<void> | null = null;` },
    { code: `${API_IMPORT}let restore: (() => void) | null = null;` },

    // H3 — infrastructure by NAME, even when untyped.
    { code: `${API_IMPORT}let pollTimer = null;` },
    { code: `${API_IMPORT}let resizeObserver = null;` },
    { code: `${API_IMPORT}let unsubscribe = null;` },

    // The fix itself must not trip the rule.
    { code: `${API_IMPORT}import { projectScoped } from './projectScoped.js';\nconst lastSeenId = projectScoped(() => 0, 'x');` },
  ],

  invalid: [
    // The canonical HS-9412 shape.
    {
      code: `${API_IMPORT}let lastSeenId = 0;`,
      errors: [{ messageId: 'unscoped', data: { name: 'lastSeenId' } }],
    },
    // The canonical HS-9413/9414 shape.
    {
      code: `${API_IMPORT}let currentTicket: string | null = null;`,
      errors: [{ messageId: 'unscoped' }],
    },
    // Deeper relative import still counts as the project API.
    {
      code: "import { x } from '../../api/index.js';\nlet cachedThing = null;",
      errors: [{ messageId: 'unscoped' }],
    },
    // Every declarator in one statement is reported.
    {
      code: `${API_IMPORT}let a = 0, b = 1;`,
      errors: [{ messageId: 'unscoped' }, { messageId: 'unscoped' }],
    },
    // An uninitialized, untyped `let` is still module-level mutable state.
    {
      code: `${API_IMPORT}let pending;`,
      errors: [{ messageId: 'unscoped' }],
    },
  ],
});
