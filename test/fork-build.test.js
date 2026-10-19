import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import {
  serverReplacementReason,
  shouldKillProcessOnPort,
  shouldRestartServer,
  shutdownServerOnPort,
} from "../src/cli.js";
import {
  FORK_ADOPT_VERSION,
  FORK_BUILD_HEADER,
  FORK_BUILD_ID,
  forkServerVersion,
  isForkBuildRequest,
} from "../src/fork-build.js";
import { serve } from "../src/server.js";

const FORK_HEADERS = { [FORK_BUILD_HEADER]: FORK_BUILD_ID };
// Releases an `npx -y lavish-axi` could resolve, now and later. The upstream CLI runs this same
// shouldRestartServer / shouldKillProcessOnPort logic (the fork does not change either function).
const UPSTREAM_CLI_VERSIONS = ["0.1.88", "0.1.89", "0.1.100", "0.2.0", "1.0.0", "99999.99.99"];

async function withServer(version, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-fork-build-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version,
    detectTailscale: async () => null,
  });
  try {
    await run(server, `http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function health(base, headers = {}, query = "") {
  const response = await fetch(`${base}/health${query}`, { headers });
  assert.equal(response.status, 200);
  return response.json();
}

test("isForkBuildRequest accepts only the exact fork build id", () => {
  assert.equal(isForkBuildRequest({ [FORK_BUILD_HEADER]: FORK_BUILD_ID }), true);
  assert.equal(isForkBuildRequest({}), false);
  assert.equal(isForkBuildRequest(undefined), false);
  assert.equal(isForkBuildRequest({ [FORK_BUILD_HEADER]: "kunchenguid" }), false);
  assert.equal(isForkBuildRequest({ [FORK_BUILD_HEADER]: `${FORK_BUILD_ID} ` }), false);
});

test("forkServerVersion reads the real version from a guarded answer and passes others through", () => {
  assert.equal(
    forkServerVersion({ version: FORK_ADOPT_VERSION, build: FORK_BUILD_ID, fork_version: "0.1.88" }),
    "0.1.88",
  );
  assert.equal(forkServerVersion({ version: "0.1.88", build: FORK_BUILD_ID }), "0.1.88");
  // An unguarded fork server (0.1.87 and older) and an upstream server report their version as is.
  assert.equal(forkServerVersion({ version: "0.1.87" }), "0.1.87");
  assert.equal(forkServerVersion({ version: "0.1.87", fork_version: "9.9.9" }), "0.1.87");
  assert.equal(forkServerVersion(null), undefined);
});

test("/health without the fork header makes every upstream CLI adopt the server", async () => {
  await withServer("0.1.88", async (_server, base) => {
    const body = await health(base, {}, "?reconcile_network=1");
    assert.equal(body.app, "lavish-axi");
    assert.equal(body.version, FORK_ADOPT_VERSION);
    assert.equal(body.fork_version, "0.1.88");
    assert.equal(body.build, FORK_BUILD_ID);
    assert.equal(body.network_stale, undefined);
    for (const cliVersion of UPSTREAM_CLI_VERSIONS) {
      assert.equal(shouldRestartServer(cliVersion, body), false, `upstream ${cliVersion} must adopt`);
      assert.equal(shouldKillProcessOnPort(cliVersion, body), false, `upstream ${cliVersion} must never SIGTERM`);
      assert.equal(serverReplacementReason(cliVersion, body), "");
    }
  });
});

test("/health with the fork header reports the real version so fork CLIs still upgrade", async () => {
  await withServer("0.1.88", async (_server, base) => {
    const body = await health(base, FORK_HEADERS);
    assert.equal(body.version, "0.1.88");
    assert.equal(body.build, FORK_BUILD_ID);
    assert.equal(body.fork_version, undefined);
    assert.equal(shouldRestartServer("0.1.88", body), false, "same fork build adopts");
    assert.equal(shouldRestartServer("0.1.89", body), true, "a newer fork CLI replaces it");
    assert.equal(serverReplacementReason("0.1.89", body), "upgrade");
    assert.equal(shouldRestartServer("0.1.87", body), false, "an older fork CLI adopts it");
  });
});

test("a fork CLI replaces an older, unguarded fork server", () => {
  // What a 0.1.87 fork server (no guard) answers whatever headers it is sent.
  const unguarded = { ok: true, app: "lavish-axi", version: "0.1.87" };
  assert.equal(shouldRestartServer("0.1.88", { ...unguarded, version: forkServerVersion(unguarded) }), true);
  assert.equal(shouldKillProcessOnPort("0.1.88", unguarded), true);
});

test("/shutdown without the fork header is refused and the server keeps serving", async () => {
  await withServer("0.1.88", async (_server, base) => {
    const refused = await fetch(`${base}/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "upgrade" }),
    });
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.ok, false);
    assert.equal(body.build, FORK_BUILD_ID);
    assert.match(body.error, /lavish-axi stop/);
    assert.equal((await health(base)).ok, true);
  });
});

test("an upstream-style stop leaves the fork server running", async () => {
  await withServer("0.1.88", async (_server, base) => {
    // The upstream CLI's stop: header-less health, header-less shutdown, kill only if older.
    const result = await shutdownServerOnPort(0, {
      baseUrl: base,
      currentVersion: "0.2.0",
      fetchHealth: async (url) => (await fetch(`${url}/health`)).json(),
      requestShutdown: async (url) => {
        await fetch(`${url}/shutdown`, { method: "POST" });
      },
      waitForPortFree: async () => false,
      killServerProcess: () => assert.fail("must not SIGTERM a fork server"),
    });
    assert.equal(result.server.status, "stopping");
    assert.equal((await health(base)).ok, true);
  });
});

test("the fork's own `lavish-axi stop` path still stops a guarded server", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-fork-build-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "0.1.88",
    detectTailscale: async () => null,
  });
  try {
    const result = await shutdownServerOnPort(server.port, {
      baseUrl: `http://127.0.0.1:${server.port}`,
      currentVersion: "0.1.88",
      killServerProcess: () => assert.fail("a guarded fork server stops over /shutdown"),
    });
    assert.deepEqual(result, { server: { status: "stopped", port: server.port } });
    await server.done;
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
