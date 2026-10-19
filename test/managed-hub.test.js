import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function runCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (out += chunk));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, out })));
}

/** @param {NodeJS.ProcessEnv} env @param {number} port */
function startHub(env, port) {
  const hub = spawn(process.execPath, [CLI, "server", "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  hub.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  return { hub, stderr: () => stderr };
}

/** @param {number} port */
async function serving(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

/** @param {() => Promise<boolean>} predicate @param {AbortSignal} signal @param {string} label */
async function until(predicate, signal, label) {
  while (!signal.aborted) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// A service manager restarts the hub while a poll loop keeps calling the CLI. The CLI must leave
// the port to the hub instead of spawning a server that takes it and makes the hub crash-loop.
test("a hub restarted under an active poll loop gets its port back and no server is spawned", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-managed-hub-"));
  const port = await freePort();
  const stateDir = path.join(dir, "state");
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_IDLE_TIMEOUT_MS: "off",
  };
  const artifact = path.join(dir, "page.html");
  await writeFile(artifact, "<!doctype html><title>x</title><p>ok</p>\n", "utf8");

  const first = startHub(env, port);
  /** @type {ReturnType<typeof startHub> | null} */
  let second = null;
  let polling = false;
  /** @type {Promise<void>} */
  let loop = Promise.resolve();
  try {
    await until(() => serving(port), t.signal, "the first hub");
    const opened = await runCli([artifact, "--no-open"], env);
    assert.equal(opened.status, 0, opened.out);
    polling = true;
    loop = (async () => {
      while (polling) await runCli(["poll", artifact, "--owner", "test-poll-loop", "--timeout-ms", "300"], env);
    })();
    first.hub.kill("SIGTERM");
    await once(first.hub, "exit");
    // The service manager's restart delay: the poll loop keeps running through it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    second = startHub(env, port);
    const restarted = second;
    await until(
      async () => restarted.hub.exitCode !== null || (await serving(port)),
      t.signal,
      "the restarted hub or a server",
    );
    // Give a spawned server time to win the port race if the CLI started one.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // The hub records itself only after it has bound the port, and exits if anything else holds it.
    assert.equal(restarted.hub.exitCode, null, `the restarted hub exited: ${restarted.stderr()}`);
    const after = JSON.parse(await readFile(path.join(stateDir, "managed-hub.json"), "utf8"));
    assert.equal(after.pid, restarted.hub.pid, "the restarted hub never bound the port");
    assert.equal(await serving(port), true);
  } finally {
    polling = false;
    await loop;
    first.hub.kill("SIGTERM");
    second?.hub.kill("SIGTERM");
    await runCli(["stop"], env);
    await rm(dir, { recursive: true, force: true });
  }
});

// The hub's record is the claim on the port, not its process or its age: a hub its service manager
// is slow to restart keeps the port. Only `lavish-axi stop` (or deleting the file) releases it.
test("an old hub record whose process is gone still stops a CLI from spawning a server until stop clears it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-managed-hub-latch-"));
  const port = await freePort();
  const stateDir = path.join(dir, "state");
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
  };
  const artifact = path.join(dir, "page.html");
  await writeFile(artifact, "<!doctype html><title>x</title><p>ok</p>\n", "utf8");
  const gone = spawn(process.execPath, ["-e", ""]);
  await once(gone, "exit");
  await mkdir(stateDir, { recursive: true });
  const record = path.join(stateDir, "managed-hub.json");
  await writeFile(record, `${JSON.stringify({ pid: gone.pid, port })}\n`, "utf8");
  const anHourAgo = new Date(Date.now() - 3_600_000);
  await utimes(record, anHourAgo, anHourAgo);
  try {
    // A short start timeout only bounds how long this CLI waits for the absent hub.
    const refused = await runCli([artifact, "--no-open"], { ...env, LAVISH_AXI_SERVER_START_TIMEOUT_MS: "1500" });
    assert.notEqual(refused.status, 0, `a server was spawned over the hub's record:\n${refused.out}`);
    assert.match(refused.out, /A managed Lavish hub owns port \d+ .* but is not answering/);
    assert.equal(await serving(port), false, "a server answers on the hub's port");

    const stopped = await runCli(["stop"], env);
    assert.equal(stopped.status, 0, stopped.out);
    await assert.rejects(stat(record), "stop left the hub record behind");
    const opened = await runCli([artifact, "--no-open"], env);
    assert.equal(opened.status, 0, opened.out);
    assert.equal(await serving(port), true);
  } finally {
    await runCli(["stop"], env);
    await rm(dir, { recursive: true, force: true });
  }
});
