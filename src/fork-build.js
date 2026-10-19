// navidRashik/lavish-axi fork identity on the CLI <-> server handshake.
//
// Every upstream lavish-axi CLI decides from /health whether a running server is older than itself
// and, if so, POSTs /shutdown and falls back to SIGTERM. An `npx -y lavish-axi` that resolves a
// newer upstream release therefore replaced this fork's server and lost its state. Upstream CLI
// code cannot be changed, so the fork server answers differently depending on who is asking:
//
// - A request carrying FORK_BUILD_HEADER (only this fork's CLI sends it) gets the real version and
//   the real network_stale flag, so fork CLIs still replace an older fork server on upgrade.
// - Any other /health gets FORK_ADOPT_VERSION, which numerically beats every upstream release, and
//   never network_stale, so every upstream CLI adopts the server instead of replacing it. The real
//   version rides along in `fork_version`.
// - Any other /shutdown is refused with 409, so nothing upstream can stop the server over HTTP, and
//   the SIGTERM fallback never fires because it only kills a server older than the CLI.
export const FORK_BUILD_HEADER = "x-lavish-build";
export const FORK_BUILD_ID = "navidRashik-fork";
export const FORK_ADOPT_VERSION = "999999.0.0";

export function isForkBuildRequest(headers) {
  return String(headers?.[FORK_BUILD_HEADER] ?? "") === FORK_BUILD_ID;
}

// The version this fork's CLI compares against. A guarded fork server always answers a header-bearing
// probe with its real version; `fork_version` covers a header-less answer reaching the fork CLI anyway
// (a proxy that strips headers), so the fork never compares against the adopt version.
export function forkServerVersion(health) {
  if (
    health &&
    typeof health === "object" &&
    health.build === FORK_BUILD_ID &&
    typeof health.fork_version === "string"
  ) {
    return health.fork_version;
  }
  return health?.version;
}
