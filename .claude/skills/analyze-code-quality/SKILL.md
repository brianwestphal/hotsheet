---
name: analyze-code-quality
description: Run all available tests and linters, check for anti-patterns, and generate a comprehensive code quality report
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Analyze the overall quality of the source code in this project. Generate a comprehensive report.

## Steps

1. **Run unit tests with coverage**
   ```
   npm test
   ```
   Report: total tests, pass/fail count, coverage percentage by directory.

2. **Run E2E tests**
   ```
   npm run test:e2e
   ```
   Report: total E2E tests, pass/fail count.

3. **Run linter**
   ```
   npm run lint
   ```
   Report: total errors/warnings, categorized by rule.

4. **Check for anti-patterns documented in CLAUDE.md**
   Read `CLAUDE.md` and the `docs/` requirements files. Look for violations of documented conventions:
   - Files that are excessively long (check against the code organization guidelines)
   - `document.createElement()` usage instead of `toElement()` with JSX
   - Manual HTML string concatenation instead of JSX/SafeHtml
   - `exec()` instead of `execFile()` for shell commands
   - Missing `.js` extension on import paths
   - Duplicate code across files
   - Exported functions that violate the one-primary-export-per-file guideline

5. **Check TypeScript strictness**
   ```
   npx tsc --noEmit
   ```
   Report any type errors.

## Report Format

Generate a structured report with:
- **Summary**: Overall health score (tests passing, lint clean, coverage %)
- **Test Results**: Unit and E2E pass rates
- **Coverage**: By directory, highlighting files below 50%
- **Lint Issues**: Grouped by severity
- **Anti-Pattern Violations**: Specific files and lines
- **Recommendations**: Prioritized list of improvements
