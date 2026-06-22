#!/usr/bin/env bash
#
# Non-interactive beta release. Mirrors `npm run release:beta` (which runs
# `scripts/release.sh --beta`) but answers every prompt automatically so it
# can be invoked from automation (or by Claude when the user says "push a
# beta").
#
# Why a separate script instead of piping into release.sh?
# The interactive script has multiple `read`-driven branches (version-bump
# menu, "use this text?" confirms, "proceed with this BETA release?"
# confirm, resume-from-state prompts) that can't be cleanly answered with
# echo-pipes — answers depend on the run's saved state which would need to
# be pre-stubbed. Cleaner to re-implement the beta path here than to bend
# the interactive script into something it isn't.
#
# What this script does — matches release.sh --beta exactly:
#   1. Preflight: working tree must be clean; must be on main/master.
#      (Skips the `npm whoami` check the interactive script does — beta
#      releases publish via GitHub Actions' NPM_TOKEN, not the local
#      user's credentials, so local npm login isn't required for the
#      tag-and-push path. Stable releases still need it but they're not
#      this script's job.)
#   2. Read current version from package.json (interactive default for
#      "Enter to keep current_version"). Beta tags target the upcoming
#      stable version; CI's release-candidate.yml bumps it ephemerally via
#      `npm version --no-git-tag-version` at publish time.
#   3. Draft release notes with gitgist (the same tool release.sh uses) over
#      `<lastTag>..HEAD`: AI draft, then gitgist `--no-ai` deterministic
#      grouping, then a `git log` pointer. Override with `--notes <file>` /
#      `--notes-stdin`.
#   4. Build + test + lint + typecheck (same as interactive step 7).
#   5. Auto-increment the beta number: find the highest existing
#      `v<version>-beta.N` tag and pick N+1. Same logic as the
#      interactive `step_beta_tag_and_push`.
#   6. Annotated git tag with the release notes as the message; push the
#      tag (NOT a commit — beta mode skips version-file bumps + the
#      release commit).
#
# What CI does on push of the tag — release-candidate.yml (unified workflow,
# triggers on both `v*-rc.*` and `v*-beta.*` tags; see HS-8464):
#   1. Re-runs tests + lint + build verification.
#   2. Publishes hotsheet@<version>-beta.N to npm with `--tag beta`
#      (does NOT promote to `@latest`).
#   3. Builds Tauri bundles (macOS-arm64 + macOS-x64 + Linux + Windows).
#   4. Creates a GitHub Release flagged prerelease: true so the Tauri
#      updater + the §50 upgrade-nudge skip it (they only resolve
#      releases/latest, which GitHub auto-filters past prereleases).
#
# To install the beta:
#   - npm:        npm install hotsheet@beta
#   - desktop:    download the binary from the GitHub Release page
#
# To revert a beta tag (if a release is botched before CI completes):
#   git tag -d v<version>-beta.N
#   git push origin :refs/tags/v<version>-beta.N
#
# Exit codes:
#   0 — beta tag pushed (or --dry-run completed); CI is running.
#   1 — preflight failure (dirty tree, wrong branch, missing tools).
#   2 — local checks failed (test / lint / tsc).
#   3 — git tag or push failed (often: tag already exists, or upstream
#       rejected — usually means we need to pull first).
#
set -euo pipefail

# --- Colors (stripped on non-tty for log readability) ---
if [[ -t 1 ]]; then
  BOLD="\033[1m"; DIM="\033[2m"; GREEN="\033[32m"; YELLOW="\033[33m"
  RED="\033[31m"; CYAN="\033[36m"; RESET="\033[0m"
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi
info()    { echo -e "${CYAN}${BOLD}>>>${RESET} $1"; }
success() { echo -e "${GREEN}${BOLD}>>>${RESET} $1"; }
warn()    { echo -e "${YELLOW}${BOLD}>>>${RESET} $1"; }
error()   { echo -e "${RED}${BOLD}>>>${RESET} $1" >&2; }

# --- Preflight ---
preflight() {
  info "Preflight..."

  if [[ ! -f "package.json" ]]; then
    error "No package.json — run from the project root."
    exit 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    error "Working tree is dirty. Commit or stash before running a beta."
    git status --short >&2
    exit 1
  fi

  local branch
  branch=$(git branch --show-current)
  if [[ "$branch" != "main" && "$branch" != "master" ]]; then
    error "Current branch is '${branch}', not main/master. Refusing to push a beta from a side branch."
    exit 1
  fi

  if ! command -v node >/dev/null; then
    error "node not found on PATH."
    exit 1
  fi

  # HS-8453 follow-up — fetch tags from origin before `read_version` /
  # `draft_release_notes` / `tag_and_push` read the local tag list. A
  # stale local clone would (a) compute the wrong "previous tag"
  # anchor for the notes diff, (b) auto-increment to a beta number the
  # remote already holds (causing the subsequent `git push origin
  # <tag>` to fail). Intentionally NOT using `--prune-tags` — deleting
  # local-only tags that haven't been pushed yet would be too
  # aggressive. Failure is non-fatal (offline / no remote / network
  # blip): proceed with whatever local state we have, and the
  # downstream push surfaces any conflict.
  info "Fetching tags from origin..."
  if ! git fetch --tags origin 2>/dev/null; then
    warn "git fetch --tags failed (offline?) — proceeding with local tag list."
  fi

  success "Preflight clean (branch=${branch}, tree clean)"
}

# --- Steps ---
read_version() {
  # The interactive flow shows a menu (Enter = keep current, 1 = patch,
  # 2 = minor, 3 = major, 4 = custom). In practice the user always picks
  # 2 (minor) for beta releases — betas target the upcoming X.Y.0
  # release, not the current X.Y.Z. So our default is "next minor" not
  # "keep current". Explicit override via `--version X.Y.Z` for the rare
  # case where the upcoming release is a patch / major / custom.
  #
  # We also guard the "next minor" pick against an already-stable
  # version: if `v<NEXT_MINOR>-beta.N` tags exist, we're continuing that
  # beta series — exactly what we want. If `v<CURRENT_VERSION>` is a
  # tag (this version already shipped stable), we'd never want to target
  # it — `next minor` is the only sensible default. If `v<CURRENT>`
  # is NOT yet a tag, the current package.json is the upcoming release
  # itself and we should target it directly — pick that.
  if [[ -n "${OVERRIDE_VERSION:-}" ]]; then
    VERSION="$OVERRIDE_VERSION"
    info "Target version (from --version): ${BOLD}${VERSION}${RESET}"
    return
  fi

  local current
  current=$(node -p "require('./package.json').version")

  # If package.json points at a version that hasn't shipped as a stable
  # tag yet, package.json IS the upcoming target. Otherwise next-minor.
  local target
  if git rev-parse "v${current}" >/dev/null 2>&1; then
    # Current is already a stable tag — package.json hasn't been bumped
    # yet. Pick next-minor.
    local major minor patch
    IFS='.' read -r major minor patch <<< "$current"
    target="${major}.$((minor + 1)).0"
    info "Current package.json (${current}) is already a stable tag — targeting next minor: ${BOLD}${target}${RESET}"
  else
    # Current isn't a stable tag yet — package.json IS the upcoming target.
    target="$current"
    info "Current package.json (${target}) is not yet a stable tag — targeting it directly"
  fi

  VERSION="$target"
  info "Beta tag will be ${BOLD}v${VERSION}-beta.N${RESET} for the next free N"
}

# Prefer the locally-installed binary (devDependency), then a PATH gitgist.
# Echoes the resolved command, or nothing if gitgist isn't available.
resolve_gitgist() {
  if [[ -x "node_modules/.bin/gitgist" ]]; then
    echo "node_modules/.bin/gitgist"
  elif command -v gitgist >/dev/null; then
    echo "gitgist"
  fi
}

draft_release_notes() {
  # Draft notes with gitgist — the same engine release.sh::step_release_notes
  # uses (HS-8870) — over the commit range since the last tag. gitgist owns the
  # prompt, the AI-provider selection (its default `auto` backend reuses the
  # signed-in `claude` CLI, then $ANTHROPIC_API_KEY, then the on-device Apple
  # helper), code-fence stripping, and noise filtering (ticket IDs, refactors,
  # tests, CI/doc-only changes). This replaces the bespoke `claude -p` plumbing
  # this step used to carry: the hand-rolled prompt, the stdout auth-error
  # string-matching (gitgist signals failure via a non-zero exit, not error
  # text on stdout — HS-8439), and the ARG_MAX stdin workaround (gitgist reads
  # the git range itself — HS-8453).
  #
  # Fallback chain mirrors glassbox: gitgist AI draft -> gitgist `--no-ai`
  # deterministic grouping -> a bare `git log` pointer. The `--no-ai` rung means
  # notes never collapse to "see git log" just because no AI provider was
  # reachable.
  #
  # `--notes <file>` / `--notes-stdin` short-circuit gitgist entirely. Intended
  # for callers (humans or other Claude sessions) that already have notes
  # drafted and don't want to spawn a nested model call.
  if [[ -n "${NOTES_OVERRIDE:-}" ]]; then
    NOTES="$NOTES_OVERRIDE"
    info "Using release notes from ${BOLD}${NOTES_SOURCE_LABEL}${RESET}:"
    echo "$NOTES" | sed 's/^/    /'
    echo ""
    return
  fi

  # Beta notes anchor at the most recent tag (beta or stable) — they're
  # incremental and shouldn't repeat bullets from an earlier beta. Same anchor
  # as release.sh's beta path.
  local last_tag range
  last_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  range="${last_tag:+${last_tag}..HEAD}"
  local pointer="- See \`git log ${range:-HEAD}\` for details."

  local gitgist
  gitgist=$(resolve_gitgist)
  if [[ -z "$gitgist" ]]; then
    warn "'gitgist' not found (run 'npm install' — it's a devDependency). Using a git-log pointer."
    NOTES="$pointer"
    return
  fi

  info "Drafting release notes with gitgist (${range:-since last tag})..."
  # gitgist is well-behaved on failure: it exits non-zero, writes the error to
  # stderr, and prints nothing to stdout. We still guard against its
  # "_No commits…_" sentinel becoming the tag body. Capture stderr so we can
  # surface the last line if the AI draft falls through.
  local errfile generated
  errfile=$(mktemp "${TMPDIR:-/tmp}/gitgist-beta-auto.XXXXXX")
  generated=$("$gitgist" ${range:+"$range"} 2>"$errfile" || true)
  [[ "$generated" == _No\ * ]] && generated=""

  # Fall back to gitgist's deterministic (no-AI) grouping if the AI draft failed
  # or no provider was available — better than a bare log pointer.
  if [[ -z "$generated" ]]; then
    warn "gitgist AI draft empty/failed — trying deterministic (--no-ai) grouping."
    [[ -s "$errfile" ]] && warn "  $(tail -1 "$errfile" 2>/dev/null)"
    generated=$("$gitgist" ${range:+"$range"} --no-ai 2>/dev/null || true)
    [[ "$generated" == _No\ * ]] && generated=""
  fi
  rm -f "$errfile"

  NOTES="${generated:-$pointer}"

  echo ""
  echo -e "    ${DIM}Drafted notes:${RESET}"
  echo "$NOTES" | sed 's/^/    /'
  echo ""
}

run_local_checks() {
  info "Build + tests + lint + typecheck..."

  npm run build
  echo ""

  if [[ "${SKIP_TESTS:-false}" == "true" ]]; then
    warn "Skipping unit tests (--skip-tests). Use only when you've verified the suite passes elsewhere."
  else
    info "Unit tests..."
    # Auto-retry once on failure. The project's test suite has a few
    # known-flaky files under heavy parallel load (feedback-state /
    # lifecycle-e2e / cli.test --demo:0 — PGLite initdb timing + tsx
    # spawn jitter). A second pass with a now-warm node-modules cache
    # almost always succeeds; if the second pass also fails, the
    # failure is more likely real and we bail.
    if ! npm test; then
      warn "Unit tests failed on first pass — retrying once in case of load-induced flake..."
      npm test || { error "Unit tests failed after retry. Inspect output above; re-run with --skip-tests if you've validated the failure is environmental and not a real regression."; exit 2; }
    fi
    echo ""
  fi

  info "Lint..."
  npm run lint || { error "Lint failed."; exit 2; }
  echo ""

  info "Type check..."
  npx tsc --noEmit || { error "tsc failed."; exit 2; }
  echo ""

  success "All local checks passed"
}

tag_and_push() {
  # Same auto-increment logic as release.sh::step_beta_tag_and_push.
  local n=1
  while git rev-parse "v${VERSION}-beta.${n}" >/dev/null 2>&1; do
    n=$((n + 1))
  done
  BETA_TAG="v${VERSION}-beta.${n}"

  if [[ "${DRY_RUN:-false}" == "true" ]]; then
    echo ""
    success "Dry run complete — would create + push ${BOLD}${BETA_TAG}${RESET} (commit $(git rev-parse --short HEAD)) with the drafted notes."
    info "Re-run without --dry-run to cut the beta."
    return
  fi

  info "Creating tag ${BOLD}${BETA_TAG}${RESET} with the drafted release notes..."
  # Annotated tag, notes as the message.
  echo -e "$NOTES" | git tag -a "$BETA_TAG" -F - || { error "git tag -a failed."; exit 3; }

  info "Pushing tag to origin..."
  git push origin "$BETA_TAG" || {
    error "git push failed. Tag exists locally but not on origin."
    error "To retry after fixing: git push origin ${BETA_TAG}"
    error "To unwind: git tag -d ${BETA_TAG}"
    exit 3
  }

  echo ""
  success "Beta tag ${BOLD}${BETA_TAG}${RESET} pushed."
  echo ""
  echo -e "  ${DIM}CI is now:${RESET}"
  echo -e "    1. Re-running tests, lint, build verification."
  echo -e "    2. Publishing hotsheet@${VERSION}-beta.${n} to npm with --tag beta."
  echo -e "    3. Building Tauri bundles for every platform."
  echo -e "    4. Creating a GitHub Release flagged ${BOLD}prerelease: true${RESET}."
  echo ""
  echo -e "  ${DIM}Install via:${RESET}  npm install hotsheet@beta"
  echo -e "  ${DIM}Or from the GitHub Release page once the bundles upload.${RESET}"
  echo ""
  echo -e "  ${DIM}Monitor:${RESET} https://github.com/brianwestphal/hotsheet/actions"
}

# --- Argv parsing ---
# Currently supports: --version X.Y.Z (override the auto-derived target
# version), --skip-tests (bypass the local unit-test step),
# --notes <file> / --notes-stdin (supply pre-drafted release notes and
# skip the nested `claude -p` call — HS-8439). All other args are
# unrecognized and rejected so a typo doesn't silently fall through into
# a default beta release.
OVERRIDE_VERSION=""
SKIP_TESTS="false"
DRY_RUN="false"
NOTES_OVERRIDE=""
NOTES_SOURCE_LABEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      OVERRIDE_VERSION="${2:-}"
      if [[ -z "$OVERRIDE_VERSION" ]]; then
        error "--version requires a value (e.g. --version 0.17.0)"
        exit 1
      fi
      shift 2
      ;;
    --version=*)
      OVERRIDE_VERSION="${1#--version=}"
      shift
      ;;
    --skip-tests)
      SKIP_TESTS="true"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --notes)
      if [[ -z "${2:-}" ]]; then
        error "--notes requires a file path (e.g. --notes /tmp/notes.md). Use --notes-stdin to read from stdin."
        exit 1
      fi
      if [[ ! -f "$2" ]]; then
        error "--notes file not found: $2"
        exit 1
      fi
      NOTES_OVERRIDE=$(cat "$2")
      NOTES_SOURCE_LABEL="--notes $2"
      shift 2
      ;;
    --notes=*)
      notes_path="${1#--notes=}"
      if [[ ! -f "$notes_path" ]]; then
        error "--notes file not found: $notes_path"
        exit 1
      fi
      NOTES_OVERRIDE=$(cat "$notes_path")
      NOTES_SOURCE_LABEL="--notes=$notes_path"
      shift
      ;;
    --notes-stdin)
      NOTES_OVERRIDE=$(cat)
      NOTES_SOURCE_LABEL="--notes-stdin"
      shift
      ;;
    -h|--help)
      cat <<EOF
Usage: bash scripts/release-beta-auto.sh [--version X.Y.Z] [--skip-tests] [--dry-run] [--notes <file> | --notes-stdin]

Non-interactive beta release for Hot Sheet. Matches \`npm run release:beta\`
without prompts. By default targets the upcoming X.Y.0 (next minor from
current package.json) unless package.json is already ahead of the latest
stable tag, in which case the current version is used directly. Override
with --version to point at an explicit upcoming release.

The unit-test step auto-retries once on failure (catches load-induced
flakes in feedback-state / lifecycle-e2e / cli.test --demo:0). Pass
--skip-tests to bypass entirely after you've validated the suite
passes some other way (e.g. you just ran \`npm test\` clean in a
separate terminal). CI re-runs everything on tag-push regardless.

Release notes are drafted by gitgist (the tool the interactive release
uses) over <lastTag>..HEAD — AI draft, then gitgist --no-ai, then a
git-log pointer. Pass --notes <file> (or --notes-stdin) to supply
pre-drafted notes and skip gitgist entirely.

--dry-run does everything EXCEPT create and push the tag (preflight,
version, notes, build, tests) so you can verify a release before
committing to it.

Examples:
  npm run release:beta:auto
  npm run release:beta:auto -- --version 0.18.0
  npm run release:beta:auto -- --version 0.18.0 --dry-run
  npm run release:beta:auto -- --skip-tests
  npm run release:beta:auto -- --notes /tmp/notes.md
  echo "- fix bug X" | npm run release:beta:auto -- --notes-stdin
EOF
      exit 0
      ;;
    *)
      error "Unrecognized arg: $1"
      error "Usage: bash scripts/release-beta-auto.sh [--version X.Y.Z] [--skip-tests] [--dry-run] [--notes <file> | --notes-stdin]"
      exit 1
      ;;
  esac
done

# --- Main ---
echo ""
echo -e "${BOLD}  Hot Sheet Beta — auto/non-interactive${RESET}"
[[ "${DRY_RUN:-false}" == "true" ]] && echo -e "  ${DIM}--dry-run: no tag will be created or pushed.${RESET}"
echo ""

preflight
read_version
draft_release_notes
run_local_checks
tag_and_push
