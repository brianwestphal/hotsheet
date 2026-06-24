---
name: check-code-hygiene
description: Check code for standardization, readability, maintenance complexity, and defensive coding practices
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Analyze the codebase for code hygiene issues. Generate a report highlighting problems with standardization, human readability, maintenance complexity, and defensive coding.

## Analysis Areas

### 1. Standardization
- **Naming conventions**: Are functions, variables, files, and CSS classes named consistently?
- **File organization**: Do files follow the one-primary-export-per-file guideline from CLAUDE.md?
- **Import patterns**: Are imports sorted consistently? Are relative vs absolute paths used consistently?
- **Error handling patterns**: Is error handling consistent across similar operations (e.g., API calls, DB queries, file I/O)?
- **Code style**: Are there mixed patterns for the same thing (e.g., some callbacks use arrow functions, others use function declarations)?

### 2. Human Readability
- **Function length**: Flag functions over 50 lines that should be broken up
- **Nesting depth**: Flag code with more than 3 levels of nesting
- **Magic numbers/strings**: Flag hardcoded values that should be constants
- **Unclear naming**: Flag variables/functions with ambiguous names (single letters, acronyms, etc.)
- **Missing context**: Complex logic without comments explaining the "why"

### 3. Maintenance Complexity
- **Coupling**: Identify tightly coupled modules that are hard to change independently
- **Shared mutable state**: Flag module-level mutable state that could cause bugs
- **Callback chains**: Flag deeply nested callbacks or promise chains that could be simplified
- **Large switch/if-else chains**: Flag complex branching that could be refactored
- **Duplicate patterns**: Code that does the same thing in slightly different ways

### 4. Defensive Coding
- **Input validation**: Are API inputs validated at the boundary?
- **Error boundaries**: Are errors caught and handled, or do they crash the process?
- **Null safety**: Are optional values checked before use?
- **SQL injection**: Are queries parameterized?
- **Type safety**: Are `any` types used where specific types would be safer?

## Report Format

For each finding:
- **File**: path and line numbers
- **Category**: standardization | readability | maintenance | defensive
- **Severity**: high | medium | low
- **Description**: What the issue is
- **Suggestion**: How to fix it

End with a prioritized summary of the top 10 most impactful improvements.
