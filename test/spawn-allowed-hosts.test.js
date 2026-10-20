import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const ALLOWED = "hub.example.ts.net";

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

/** Status of GET / at 127.0.0.1:port sent with the given Host header. */
function statusFor(port, host) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers: { host: `${host}:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForHealth(port, signal) {
  while (!signal.aborted) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`, { signal });
      if (health.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server never became healthy");
}

/** @param {string} dir @param {number} port @returns {NodeJS.ProcessEnv} */
function baseEnv(dir, port) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: path.join(dir, "state"),
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
  };
  delete env.LAVISH_AXI_ALLOWED_HOSTS;
  return env;
}

// The hub's allowlist comes from its service environment only. A client started without that
// environment that has to spawn a replacement server must start it with the same allowlist.
test("a server a client spawns keeps the Host allowlist the hub server was started with", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-allowed-hosts-"));
  const port = await freePort();
  const env = baseEnv(dir, port);
  const artifact = path.join(dir, "page.html");
  await writeFile(artifact, "<!doctype html><title>x</title><p>ok</p>\n", "utf8");
  const hub = spawn(process.execPath, [CLI, "server", "--port", String(port)], {
    env: { ...env, LAVISH_AXI_ALLOWED_HOSTS: ALLOWED },
    stdio: "ignore",
  });
  try {
    await waitForHealth(port, t.signal);
    assert.equal(await statusFor(port, ALLOWED), 200, "fixture: the hub serves its allowed host");
    // A clean stop removes the hub's record, so the CLI below may spawn a server.
    const hubExited = once(hub, "exit");
    const stopped = await runCli(["stop"], env);
    assert.equal(stopped.status, 0, stopped.out);
    await hubExited;

    const opened = await runCli([artifact, "--no-open"], env);
    assert.equal(opened.status, 0, opened.out);
    assert.equal(await statusFor(port, ALLOWED), 200, "the spawned server lost the hub's allowlist");
    assert.equal(await statusFor(port, "bogus.example.com"), 403, "the spawned server accepts any host");
  } finally {
    hub.kill("SIGTERM");
    await runCli(["stop"], env);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a client refuses to spawn a server when the recorded allowlist cannot be read", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-allowed-hosts-bad-"));
  const port = await freePort();
  const env = baseEnv(dir, port);
  const artifact = path.join(dir, "page.html");
  await writeFile(artifact, "<!doctype html><title>x</title><p>ok</p>\n", "utf8");
  await mkdir(path.join(dir, "state"));
  await writeFile(path.join(dir, "state", "allowed-hosts.json"), "{not json", "utf8");
  try {
    const opened = await runCli([artifact, "--no-open"], env);
    assert.notEqual(opened.status, 0, opened.out);
    assert.match(opened.out, /Not starting a Lavish server: the recorded Host allowlist .* is not valid/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), "a server started anyway");
  } finally {
    await runCli(["stop"], env);
    await rm(dir, { recursive: true, force: true });
  }
});
