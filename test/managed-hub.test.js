import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  delete env.LAVISH_AXI_HUB_RESTART_GRACE_MS;
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
    await runCli(["stop"], { ...env, LAVISH_AXI_HUB_RESTART_GRACE_MS: "0" });
    await rm(dir, { recursive: true, force: true });
  }
});
