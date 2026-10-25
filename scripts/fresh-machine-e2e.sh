#!/usr/bin/env bash
# End-to-end check of what a brand-new machine gets: build <ref> of this repository, install it
# globally into a throwaway HOME and npm prefix, install the lavish skill from the installed
# package the way `npx skills add` does, ask a real agent for a small report page, then check
# the page in headless Chrome (scripts/fresh-machine-check.js). Exits 0 only when every check
# passes; 1 when a check fails; 2 on a setup failure.
#
#   scripts/fresh-machine-e2e.sh <ref> <scratch-dir> [port]
#
# LAVISH_E2E_AGENT  command run in the scratch HOME with the request in $LAVISH_E2E_PROMPT
#                   (default: omp in print mode). The caller's environment passes through, so
#                   model credentials in env vars keep working; GOOGLE_APPLICATION_CREDENTIALS
#                   defaults to the caller's gcloud application-default credentials file.
# CHROME_BIN        Chrome or Chromium for the check.
set -uo pipefail

ref="${1:?usage: fresh-machine-e2e.sh <ref> <scratch-dir> [port]}"
dir="${2:?usage: fresh-machine-e2e.sh <ref> <scratch-dir> [port]}"
port="${3:-47400}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
real_home="$HOME"

die() { echo "SETUP FAIL: $*" >&2; exit 2; }
[[ -e "$dir" ]] && die "$dir exists; pass a new directory"
mkdir -p "$dir" || die "cannot create $dir"
dir="$(cd "$dir" && pwd)"

git clone --quiet "$repo" "$dir/src" && git -C "$dir/src" checkout --quiet "$ref" || die "cannot check out $ref"
echo "ref $(git -C "$dir/src" rev-parse HEAD)"
install_deps() { if command -v pnpm >/dev/null 2>&1; then pnpm install --frozen-lockfile --silent; else npm install --silent --no-audit --no-fund; fi; }
(cd "$dir/src" && install_deps && npm pack --silent --pack-destination "$dir" >/dev/null) || die "build failed"
tarball="$(ls "$dir"/lavish-axi-*.tgz)" || die "npm pack produced no tarball"

export HOME="$dir/home" npm_config_prefix="$dir/prefix" npm_config_cache="$dir/npm-cache"
export PATH="$dir/prefix/bin:$PATH"
export LAVISH_AXI_PORT="$port" LAVISH_AXI_HOST=127.0.0.1 LAVISH_AXI_NO_OPEN=1 LAVISH_AXI_TELEMETRY=0
unset LAVISH_AXI_STATE_DIR
if [[ -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" && -f "$real_home/.config/gcloud/application_default_credentials.json" ]]; then
  export GOOGLE_APPLICATION_CREDENTIALS="$real_home/.config/gcloud/application_default_credentials.json"
fi
mkdir -p "$HOME/work"
npm install --global --silent --no-audit --no-fund "$tarball" >/dev/null || die "npm install -g failed"
[[ "$(command -v lavish-axi)" == "$dir/prefix/bin/lavish-axi" ]] || die "lavish-axi is not the scratch install"
(cd "$HOME" && npx --yes skills add "$dir/prefix/lib/node_modules/lavish-axi" --skill lavish --global --yes >/dev/null 2>&1)
[[ -f "$HOME/.agents/skills/lavish/SKILL.md" ]] || die "skill install failed"

export LAVISH_E2E_PROMPT="Make me a small report page for this week's build status: 3 services (api, web, worker); api and web are green, worker has 1 failing test (test_retry_backoff). Ask me whether to retry the worker build or roll it back. Open the page with Lavish. Do not wait for my feedback and do not run lavish-axi poll; when the page is open, reply with its file path and URL."
agent="${LAVISH_E2E_AGENT:-omp -p --no-session --approval-mode yolo \"\$LAVISH_E2E_PROMPT\"}"
(cd "$HOME/work" && bash -c "$agent") >"$dir/agent.log" 2>&1
echo "agent exit $? (log $dir/agent.log)"

page="$(find "$HOME/work" -name '*.html' ! -name '*.export.html' -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -n 1)"
[[ -n "$page" ]] || { echo "FAIL agent wrote no HTML page"; lavish-axi stop >/dev/null 2>&1; exit 1; }
echo "page $page"
session="$(lavish-axi "$page" 2>/dev/null | sed -n 's/^ *url: "\(http[^"]*\/session\/[^"]*\)".*/\1/p' | head -n 1)"
[[ -n "$session" ]] || { echo "FAIL no Lavish session for $page"; lavish-axi stop >/dev/null 2>&1; exit 1; }
echo "session $session"

node "$repo/scripts/fresh-machine-check.js" "$session" "$dir/page.png"
status=$?
lavish-axi stop >/dev/null 2>&1
echo "screenshot $dir/page.png"
exit "$status"
