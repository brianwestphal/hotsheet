import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// HS-8706 — the installed app's MCP channel server "wouldn't connect" because
// the bundled `channel.js` CRASHED on boot:
//
//   TypeError: Class2 is not a constructor
//     at _custom (channel.js)        // zod's z.custom() internal
//     at custom  (channel.js)
//     at <module load>               // @modelcontextprotocol/sdk types.js top-level
//
// `@modelcontextprotocol/sdk@1.29.0`'s `types.js` runs top-level `z.custom()`
// calls (its new Tasks-API schemas: `AssertObjectSchema`, etc.) at module-load
// time. When zod is BUNDLED into channel.js, esbuild's lazy ESM module init
// runs the SDK module body BEFORE zod's, so zod's `ZodCustom` class is still
// `undefined` when `custom()` fires. `tsx` dev never hit this — Node's real ESM
// loader initializes zod first.
//
// The fix keeps zod EXTERNAL for the channel bundle (so the runtime `import
// 'zod'` resolves the real, fully-initialized module, matching dev order) and
// ships zod alongside channel.js in the sidecar's node_modules. This is a
// cross-file contract: the tsup externalization is useless if build-sidecar.sh
// doesn't ship zod (channel.js would throw "Cannot find module 'zod'"), and
// shipping zod is pointless if tsup re-bundles it (the crash returns). These
// tests pin both sides together so neither can silently drift.
describe('channel-bundle zod-external contract (HS-8706)', () => {
  const repoRoot = process.cwd();
  const read = (...parts: string[]): string => readFileSync(join(repoRoot, ...parts), 'utf8');

  it('tsup.config.ts keeps zod external for the channel bundle', () => {
    const tsup = read('tsup.config.ts');
    // Locate the channel entry block and assert zod is externalized within it.
    const channelIdx = tsup.indexOf("entry: ['src/channel.ts']");
    expect(channelIdx).toBeGreaterThanOrEqual(0);
    // The block ends at the next entry (client bundle) — bound the search.
    const nextEntryIdx = tsup.indexOf("entry: ['src/client/app.tsx']", channelIdx);
    const channelBlock = tsup.slice(channelIdx, nextEntryIdx > 0 ? nextEntryIdx : undefined);
    expect(channelBlock).toMatch(/external:\s*\[\s*'zod'\s*\]/);
    // And it must NOT force-bundle everything (the old `noExternal: [/.*/]`
    // that re-inlines zod and reintroduces the crash).
    expect(channelBlock).not.toMatch(/noExternal:\s*\[\/\.\*\/\]/);
  });

  it('build-sidecar.sh ships zod in the runtime node_modules so the external import resolves', () => {
    const sh = read('scripts', 'build-sidecar.sh');
    // zod must be in REQUIRED_DEPS (not OPTIONAL — channel.js cannot start
    // without it once zod is external).
    const reqLine = sh.split('\n').find(l => l.trimStart().startsWith('REQUIRED_DEPS='));
    expect(reqLine).toBeDefined();
    expect(reqLine).toContain('zod');
  });
});
