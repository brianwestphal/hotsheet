// HS-9490 (docs/132 §132.9.1) — the detection evaluator: the first entry in the host
// toolkit. Nine tools each hand-rolled a `detect(projectRoot)` predicate across
// `aiInstructionsTools.ts` and `skills.ts`, and all nine were the same expression —
// "any binary on PATH, or any of these paths present". So this is one implementation
// tested once, and a plugin declares data instead of writing a closure.
//
// SERVER-ONLY (imports `fs`). The registry and the plugins stay client-safe; anything
// that needs to know whether a tool is *present* is server-side by nature.

import { existsSync } from 'fs';
import { join } from 'path';

import { isExecutableOnPath } from '../utils/isExecutableOnPath.js';
import { listPlugins } from './registry.js';
import type { AiToolPlugin, DetectionSpec } from './types.js';

/** Injection points for tests — real `fs` / PATH probing by default. */
export interface DetectDeps {
  isOnPath?: (binary: string) => boolean;
  pathExists?: (absPath: string) => boolean;
}

/**
 * Evaluate a detection spec against a project root: any binary on PATH OR any declared
 * path present. An empty spec (Goose today — no confirmed conventions) is never
 * detected, which is the correct answer rather than a gap: we would be guessing.
 */
export function detectsSpec(spec: DetectionSpec, projectRoot: string, deps: DetectDeps = {}): boolean {
  const onPath = deps.isOnPath ?? isExecutableOnPath;
  const exists = deps.pathExists ?? existsSync;
  if (spec.binaries.some(b => onPath(b))) return true;
  return spec.paths.some(p => exists(join(projectRoot, p)));
}

/** Is this tool used for the project? */
export function detectsTool(plugin: AiToolPlugin, projectRoot: string, deps: DetectDeps = {}): boolean {
  return detectsSpec(plugin.detection, projectRoot, deps);
}

/** Every plugin detected for the project, in registry order. */
export function listDetectedPlugins(projectRoot: string, deps: DetectDeps = {}): AiToolPlugin[] {
  return listPlugins().filter(p => detectsTool(p, projectRoot, deps));
}
