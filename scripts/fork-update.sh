#!/usr/bin/env bash
# Build this fork (origin/main of its clone) and install it globally with npm, then copy the
# packaged lavish skill to where agent harnesses read it. The fork is never fetched through npx:
# `npx lavish-axi` resolves the upstream npm release instead.
#
#   scripts/fork-update.sh            fetch, build, pack, install, copy SKILL.md
#   scripts/fork-update.sh --dry-run  fetch and check only; print every mutating step
#
# Environment:
#   LAVISH_FORK_REPO    clone to build (default: the clone holding this script)
#   LAVISH_NPM          npm that owns the global install (default: npm on PATH)
#   LAVISH_SKILL_DEST   where SKILL.md is copied (default: ~/.agents/skills/lavish/SKILL.md)
#   LAVISH_FORK_STATE   installed-sha record (default: ~/.lavish-axi/fork-installed-sha)
#
# Idempotent: npm pack tarballs carry no gitHead, so the installed origin/main sha is recorded in
# LAVISH_FORK_STATE and the build and install are skipped when it matches.
set -euo pipefail

# The whole run is one function, so bash has parsed it before `git switch` can rewrite this file.
main() {
  local here repo npm skill_dest sha_file dry_run=0
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo="${LAVISH_FORK_REPO:-$(dirname "$here")}"
  npm="${LAVISH_NPM:-npm}"
  skill_dest="${LAVISH_SKILL_DEST:-$HOME/.agents/skills/lavish/SKILL.md}"
  sha_file="${LAVISH_FORK_STATE:-$HOME/.lavish-axi/fork-installed-sha}"

  case "${1:-}" in
    "") ;;
    --dry-run) dry_run=1 ;;
    -h | --help)
      sed -n '2,16p' "${BASH_SOURCE[0]}"
      return 0
      ;;
    *)
      echo "usage: $(basename "$0") [--dry-run]" >&2
      return 64
      ;;
  esac

  log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
  die() {
    log "ERROR: $*" >&2
    exit 1
  }
  run() {
    if ((dry_run)); then
      log "[dry-run] would run: $*"
    else
      log "run: $*"
      "$@"
    fi
  }

  log "fork-update start (dry_run=$dry_run, repo=$repo)"
  [[ -e "$repo/.git" ]] || die "$repo is not a git clone"
  command -v "$npm" >/dev/null 2>&1 || die "$npm not found; set LAVISH_NPM to the npm that owns the global install"
  local global_pkg
  global_pkg="$("$npm" root -g)/lavish-axi"
  cd "$repo"

  # Fetching moves only remote-tracking refs, never the working tree, so it runs in dry-run too.
  log "run: git fetch origin"
  git fetch --quiet origin
  local target_sha installed_sha="" installed_version
  target_sha="$(git rev-parse origin/main)"
  log "origin/main = $target_sha"
  [[ -f "$sha_file" ]] && installed_sha="$(<"$sha_file")"
  installed_version="$(node -p 'require(process.argv[1]).version' "$global_pkg/package.json" 2>/dev/null || echo none)"
  log "installed: version=$installed_version fork_sha=${installed_sha:-none}"

  copy_skill() {
    local src="$global_pkg/skills/lavish/SKILL.md"
    if ((dry_run)); then
      log "[dry-run] would run: cp $src $skill_dest"
      return
    fi
    [[ -f "$src" ]] || die "$src missing after install"
    mkdir -p "$(dirname "$skill_dest")"
    if cmp -s "$src" "$skill_dest"; then
      log "SKILL.md already current at $skill_dest"
    else
      log "run: cp $src $skill_dest"
      cp "$src" "$skill_dest"
    fi
  }

  if [[ "$installed_sha" == "$target_sha" && -f "$global_pkg/package.json" ]]; then
    log "fork $target_sha already installed; skipping build and install"
    copy_skill
    log "done"
    return 0
  fi

  # Refuse rather than touch work in progress in the clone.
  local dirty
  dirty="$(git status --porcelain)"
  [[ -z "$dirty" ]] || die "$repo has local changes; refusing to switch or build:
$dirty"

  local orig_branch
  orig_branch="$(git symbolic-ref --quiet --short HEAD || true)"
  if [[ "$orig_branch" != "main" ]]; then
    # The tree is clean, so a switch loses nothing uncommitted. A detached HEAD would leave its
    # commits reachable only through the reflog, so that case is refused.
    [[ -n "$orig_branch" ]] || die "$repo is on a detached HEAD; refusing to switch away from it"
    log "checked out branch is $orig_branch (clean); will switch to main and return to $orig_branch afterwards"
    if ((!dry_run)); then
      # shellcheck disable=SC2064 # the branch name is fixed when the trap is set
      trap "git switch --quiet '$orig_branch' || echo 'WARN: could not switch back to $orig_branch' >&2" EXIT
    fi
  fi
  run git switch --quiet main
  run git merge --quiet --ff-only origin/main
  if ((!dry_run)); then
    [[ "$(git rev-parse HEAD)" == "$target_sha" ]] || die "main is $(git rev-parse HEAD), expected $target_sha"
  fi

  if command -v pnpm >/dev/null 2>&1; then
    run pnpm install --frozen-lockfile
    run pnpm run build
  else
    log "pnpm not found; falling back to npm ci"
    run "$npm" ci
    run "$npm" run build
  fi

  if ((dry_run)); then
    log "[dry-run] would run: $npm pack --pack-destination <tmpdir>"
    log "[dry-run] would run: $npm i -g <tmpdir>/lavish-axi-<version>.tgz"
    log "[dry-run] would write $target_sha to $sha_file"
  else
    local pack_dir tgz_name
    pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/lavish-axi-fork.XXXXXX")"
    log "run: $npm pack --pack-destination $pack_dir"
    tgz_name="$("$npm" pack --silent --pack-destination "$pack_dir" | tail -n 1)"
    [[ -f "$pack_dir/$tgz_name" ]] || die "npm pack produced no tarball (got '$tgz_name')"
    log "run: $npm i -g $pack_dir/$tgz_name"
    "$npm" i -g "$pack_dir/$tgz_name"
    rm -rf "$pack_dir"
    mkdir -p "$(dirname "$sha_file")"
    printf '%s\n' "$target_sha" >"$sha_file.tmp" && mv "$sha_file.tmp" "$sha_file"
    log "installed fork $target_sha as version $(node -p 'require(process.argv[1]).version' "$global_pkg/package.json")"
  fi

  copy_skill
  log "done"
}

main "$@"
