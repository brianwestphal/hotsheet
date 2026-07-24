/**
 * HS-9419 (docs/126 §126.6) — `hotsheet/no-unscoped-project-state`.
 *
 * The scalar half of the docs/125 guard. `PROJECT_SCOPED_CACHE_RULE` (a plain
 * `no-restricted-syntax` selector) covers module-level `new Map/Set`; it cannot
 * reach `let lastSeenId = 0`, which is the shape MOST of the eleven leaks
 * actually had.
 *
 * A bare `Program > VariableDeclaration[kind='let']` selector is unusable: it
 * matches 207 declarations across 89 client files, overwhelmingly timers, DOM
 * handles and disposers. This rule adds the two pieces of context a selector
 * language can't express, which cuts that to 99 across 45:
 *
 *   H1 — only files that import the project-scoped API (`../api/index.js`).
 *        A module that never fetches project data has no per-project state to
 *        leak.
 *   H3 — skip declarations whose TYPE or INITIALIZER identifies them as
 *        infrastructure rather than data: timer handles, DOM elements,
 *        observers, sockets, disposers, promises, signals.
 *
 * Reported at **warn**, not error: the remaining set still contains plenty of
 * legitimate one-time init flags (`let wired = false`), and a rule that cries
 * wolf gets allowlisted reflexively — which is worse than no rule, because then
 * the allowlist stops being read. See §126.6.
 */

/** Types/initializers that are never per-project DATA. */
const INFRASTRUCTURE = new RegExp(
  [
    'ReturnType<\\s*typeof\\s+set(Interval|Timeout)\\s*>', // timer handles
    'NodeJS\\.Timeout',
    '\\bHTML[A-Za-z]*Element\\b', '\\bElement\\b', '\\bNode\\b', // DOM handles
    '\\bXTerm\\b', '\\bTerminal\\b',
    '\\bAbortController\\b', '\\bWebSocket\\b',
    '\\b(Intersection|Resize|Mutation|Performance)Observer\\b',
    '\\bPromise<', '\\bSignal<', '\\bDisposable\\b',
    '\\(\\s*\\)\\s*=>\\s*void', // disposer / callback slots
  ].join('|'),
);

/** Names that read as infrastructure regardless of type. */
const INFRASTRUCTURE_NAME = /(Timer|Timeout|Interval|Observer|Disposer|Unsub|unsubscribe|Controller|Socket|Raf|AnimationFrame)/i;

/** Import specifiers that mean "this module fetches project-scoped data". */
const PROJECT_API = /(^|\/)api\/index\.js$/;

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Module-level mutable state in a client module that fetches project data should be `projectScoped` (docs/126), or explicitly justified as global.',
    },
    schema: [],
    messages: {
      unscoped:
        "Module-level `let {{name}}` in a module that fetches project data. Is it PER-PROJECT? If so use `projectScoped(() => …, 'label')` from './projectScoped.js' — a bare module-level value keeps the PREVIOUS project's data across a switch (docs/125, eleven bugs; docs/126 §126.2). If it is genuinely global (a one-time init flag, a shared DOM node's paint state — see §126.5), say so in a comment above it.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    let fetchesProjectData = false;

    /** Text of a declarator's type annotation + initializer, for the H3 test. */
    function shapeText(declarator) {
      const parts = [];
      if (declarator.id.typeAnnotation) parts.push(sourceCode.getText(declarator.id.typeAnnotation));
      if (declarator.init) parts.push(sourceCode.getText(declarator.init));
      return parts.join(' ');
    }

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value === 'string' && PROJECT_API.test(node.source.value)) {
          fetchesProjectData = true;
        }
      },

      'Program:exit'(program) {
        if (!fetchesProjectData) return;
        for (const stmt of program.body) {
          // Module level only — `let` inside a function is call-scoped and fine.
          if (stmt.type !== 'VariableDeclaration' || stmt.kind !== 'let') continue;
          for (const d of stmt.declarations) {
            if (d.id.type !== 'Identifier') continue;
            const name = d.id.name;
            if (INFRASTRUCTURE_NAME.test(name)) continue;
            if (INFRASTRUCTURE.test(shapeText(d))) continue;
            context.report({ node: d, messageId: 'unscoped', data: { name } });
          }
        }
      },
    };
  },
};
