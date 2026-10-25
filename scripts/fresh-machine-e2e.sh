#!/usr/bin/env bash
# End-to-end check of what a brand-new machine gets: build <ref> of this repository, install it
# globally into a throwaway HOME and npm prefix, install the lavish skill from the installed
# package the way `npx skills add` does, ask a real agent for two linked report pages, then
# check the one holding the question in headless Chrome (scripts/fresh-machine-check.js).
# Two negative controls follow on copies of that page - its SDK prompt calls stubbed out, and
# one navbar link pointed at a missing page - and the checker must fail each one.
# Exits 0 only when the page passes and both controls fail; 1 otherwise; 2 on a setup failure.
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

export LAVISH_E2E_PROMPT="Make me a small two-page report for this week's build status. Page 1, the status page: 3 services (api, web, worker); api and web are green, worker has 1 failing test (test_retry_backoff); ask me whether to retry the worker build or roll it back. Page 2, a details page about the failing test. Link the two pages to each other from each page's top navigation. Open both pages with Lavish. Do not wait for my feedback and do not run lavish-axi poll; when both pages are open, reply with their file paths and URLs."
agent="${LAVISH_E2E_AGENT:-omp -p --no-session --approval-mode yolo \"\$LAVISH_E2E_PROMPT\"}"
(cd "$HOME/work" && bash -c "$agent") >"$dir/agent.log" 2>&1
echo "agent exit $? (log $dir/agent.log)"

finish() { lavish-axi stop >/dev/null 2>&1; echo "exit $1"; exit "$1"; }
session_of() { lavish-axi "$1" 2>/dev/null | sed -n 's/^ *url: "\(http[^"]*\/session\/[^"]*\)".*/\1/p' | head -n 1; }
page="$(grep -rl --include='*.html' 'data-lavish-question' "$HOME/work" 2>/dev/null | grep -v '\.export\.html$' | head -n 1)"
[[ -n "$page" ]] || { echo "FAIL the agent wrote no page with a question"; finish 1; }
echo "page $page"
for other in "$(dirname "$page")"/*.html; do [[ "$other" == "$page" ]] || session_of "$other" >/dev/null; done
session="$(session_of "$page")"
[[ -n "$session" ]] || { echo "FAIL no Lavish session for $page"; finish 1; }
echo "session $session"

# Each check runs on its own copy beside the page, so relative links and house files still
# resolve. A question's answer is shared by every page holding it and disables its controls,
# so the no-prompt control runs before the page answers it; the bad-link control runs last and
# is judged on its navbar alone.
stem="${page%.html}"
node - "$page" "$stem.control-no-prompt.html" "$stem.control-bad-link.html" <<'NODE' || finish 2
const fs = require("node:fs");
const [page, noPrompt, badLink] = process.argv.slice(2);
const html = fs.readFileSync(page, "utf8");
const stub =
  "<script>(() => { const noop = () => {}; const sdk = { queuePrompt: noop, sendQueuedPrompts: noop, answerQuestion: noop," +
  " endSession: noop, getQueuedPrompts: () => [], setStatus: noop, snapshot: noop, getItem: () => null };" +
  ' Object.defineProperty(window, "lavish", { get: () => sdk, set: noop }); })();</script>';
fs.writeFileSync(noPrompt, html.replace(/<head[^>]*>/i, (head) => head + stub));
let replaced = false;
const broken = html.replace(/<nav[^>]*house-nav[\s\S]*?<\/nav>/i, (nav) =>
  nav.replace(/href="(?!#)[^"]*"/, () => ((replaced = true), 'href="missing-page.html"')),
);
if (replaced) fs.writeFileSync(badLink, broken);
NODE

# run_check <label> <file> <screenshot>: prints the checker's output and its exit code.
run_check() {
  output="$(node "$repo/scripts/fresh-machine-check.js" "$(session_of "$2")" "$2" "$3")"
  status=$?
  echo "$output"
  echo "check $1 exit $status (screenshot $3)"
}
controls_ok=1
run_check control-no-prompt "$stem.control-no-prompt.html" "$dir/control-no-prompt.png"
if [[ "$status" != 1 || "$output" != *"question id="* || "$output" != *"FAIL questionReachesServer"* ]]; then
  echo "control-no-prompt did not fail on a clicked question that never reached the server"
  controls_ok=0
fi

run_check page "$page" "$dir/page.png"
[[ "$status" == 0 ]] || finish 1

if [[ -f "$stem.control-bad-link.html" ]]; then
  run_check control-bad-link "$stem.control-bad-link.html" "$dir/control-bad-link.png"
  if [[ "$status" != 1 || "$output" != *"missing-page.html -> "*" BAD"* || "$output" != *"FAIL navLinksOtherPages"* ]]; then
    echo "control-bad-link did not fail on its missing navbar target"
    controls_ok=0
  fi
else
  echo "control-bad-link not built: the page's navbar links to no other page"
  controls_ok=0
fi
[[ "$controls_ok" == 1 ]] && finish 0
echo "FAIL a negative control did not fail as required"
finish 1
