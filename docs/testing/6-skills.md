# AI Tool Skills Testing

**Risk Level: Medium**

The skills system (`src/skills.ts`) generates configuration files for multiple AI tools (Claude Code, Cursor, GitHub Copilot, Windsurf). Bugs here can produce broken skill files, skip regeneration when needed, or corrupt existing tool configurations.

## Version Parsing

**What to test:** Both current and legacy header formats are handled.

- `parseVersionHeader()` extracts the version from `<!-- hotsheet-skill-version: 2 -->`.
- `parseVersionHeader()` extracts the version from the legacy format `<!-- hotsheet-skill-version: 1 port: 4174 -->`.
- `parseVersionHeader()` returns null for content without a version header.
- `parseVersionHeader()` returns null for malformed headers.

## File Update Logic

**What to test:** Files are written only when the version changes.

- `updateFile()` writes a new file if it doesn't exist.
- `updateFile()` overwrites if the existing file has a lower version.
- `updateFile()` skips writing if the existing file has the same or higher version.
- `updateFile()` overwrites files with the old port-based format (legacy migration).

## Platform Detection

**What to test:** Each platform is detected by the presence of its configuration directory.

- Claude Code: detected by `.claude/` directory.
- Cursor: detected by `.cursor/` directory.
- GitHub Copilot: detected by `.github/prompts/` directory or `.github/copilot-instructions.md`.
- Windsurf: detected by `.windsurf/` directory.
- Platforms without their directory are silently skipped.
- `ensureSkills()` returns the list of platforms that were updated.

## Skill Content

**What to test:** Generated files have correct content.

- The main skill includes the worklist path relative to the current working directory.
- Per-category skills include the correct category in the curl command.
- Per-category skills include the "next/up next" parsing instruction.
- The port in curl commands matches the configured skill port.
- All six ticket categories have corresponding skill files.

## Claude Code Permissions

**What to test:** `.claude/settings.json` is modified correctly.

- Static curl permission patterns for ports 4170-4189 are added if missing.
- Old dynamic port-specific patterns are removed before adding static ones.
- Existing non-Hot Sheet permissions are preserved.
- If the port is outside 4170-4189, permissions are not modified.
- A corrupt or missing `settings.json` is handled gracefully (created/overwritten).

## Skills Created Flag

**What to test:** The one-time notification flag lifecycle.

- `ensureSkills()` sets the pending flag when any platform is updated.
- `consumeSkillsCreatedFlag()` returns true once, then false on subsequent calls.
- The flag is not set if no platforms were updated.
