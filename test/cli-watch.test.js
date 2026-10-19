import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sessionKey } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin/lavish-axi.js");
const PAGES = 10;
const OWNER = "watch-test";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return port;
}

function cli(args, env) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `lavish-axi ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function until(what, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const watchPids = (feedDir) =>
  execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(" watch ") && line.includes(feedDir) && !line.includes("--add"))
    .map((line) => Number(line.trim().split(/\s+/)[0]));

test("one watch process listens on ten pages, delivers feedback and drops ended pages", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-watch-")));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    LAVISH_AXI_STATE_DIR: path.join(dir, "state"),
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
  };
  const feedDir = path.join(dir, "feed");
  const files = [];
  for (let i = 0; i < PAGES; i += 1) {
    const file = path.join(dir, `page-${i}.html`);
    await writeFile(file, `<!doctype html><title>p${i}</title><main>page ${i}</main>`);
    files.push(file);
  }
  const listeners = async () => {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    return health.listeners.filter((listener) => listener.label === OWNER);
  };
  const post = (file, route, body) =>
    fetch(`${baseUrl}/api/${sessionKey(file)}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify(body),
    });
  try {
    for (const file of files) cli([file, "--no-open"], env);
    for (const file of files) cli(["watch", "--feed-dir", feedDir, "--owner", OWNER, "--add", file], env);

    await until("ten listeners", async () => (await listeners()).length === PAGES);
    assert.equal(watchPids(feedDir).length, 1, "ten watched pages must share one process");

    const feedback = await post(files[3], "prompts", {
      prompts: [{ uid: "", prompt: "tighten the header", selector: "", tag: "message", text: "Freeform message" }],
    });
    assert.equal(feedback.status, 200, await feedback.text());
    const log3 = path.join(feedDir, "page-3.log");
    await until(
      "delivery in page-3.log",
      () => existsSync(log3) && readFileSync(log3, "utf8").includes("tighten the header"),
    );
    assert.match(readFileSync(log3, "utf8"), /· delivery \(rc=0, \d+s\)\n[\s\S]*status: feedback/);
    await until("page 3 re-armed", async () => (await listeners()).length === PAGES);

    assert.equal((await post(files[5], "end", {})).status, 200);
    await until("page 5 dropped", async () => (await listeners()).length === PAGES - 1);
    await until("end noted", () =>
      readFileSync(path.join(feedDir, "page-5.log"), "utf8").includes("page leaves the watch"),
    );

    for (const file of files) if (file !== files[5]) await post(file, "end", {});
    await until("watcher exit", () => watchPids(feedDir).length === 0 && !existsSync(path.join(feedDir, "watch.pid")));
  } finally {
    for (const pid of watchPids(feedDir)) process.kill(pid, "SIGTERM");
    spawnSync(process.execPath, [bin, "stop"], { env: { ...process.env, ...env }, timeout: 15_000 });
    await rm(dir, { recursive: true, force: true });
  }
});
