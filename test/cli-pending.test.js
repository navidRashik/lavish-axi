import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sessionKey } from "../src/session-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A port nothing listens on, so the CLI never reads listeners from a real server.
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return port;
}

function cli(args, env) {
  return spawnSync(process.execPath, [path.join(repoRoot, "bin/lavish-axi.js"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

function prompt(text) {
  return { uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" };
}

// Seeds state.json with one session per scenario: an open session with no prompts, an ended
// session whose End prompt no poll ever took, and an ended session already drained.
async function seed() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-cli-pending-")));
  const stateDir = path.join(dir, "lavish-home");
  await mkdir(stateDir, { recursive: true });
  const files = {
    open: path.join(dir, "open.html"),
    strandedEnd: path.join(dir, "stranded-end.html"),
    drainedEnd: path.join(dir, "drained-end.html"),
  };
  const session = (file, status, prompts, extra = {}) => ({
    key: sessionKey(file),
    file,
    url: `http://127.0.0.1:4387/s/${sessionKey(file)}`,
    status,
    prompts,
    pending_prompts: prompts.length,
    delivery_seq: 0,
    chat: [],
    ...extra,
  });
  const sessions = [
    session(files.open, "open", []),
    session(files.strandedEnd, "ended", [prompt("skip today")], { ended_by: "user" }),
    session(files.drainedEnd, "ended", [], { ended_by: "user" }),
  ];
  await writeFile(
    path.join(stateDir, "state.json"),
    JSON.stringify({ sessions: Object.fromEntries(sessions.map((s) => [s.key, s])) }),
  );
  const env = {
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(await closedPort()),
    LAVISH_AXI_TELEMETRY: "0",
  };
  return { dir, env, files };
}

test("home lists an ended session that still holds a prompt no poll has taken", async () => {
  const { dir, env, files } = await seed();
  try {
    const home = cli([], env);
    assert.equal(home.status, 0, home.stderr);
    assert.ok(home.stdout.includes(files.strandedEnd), `stranded ended session missing from home:\n${home.stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("home listing is unchanged for sessions with no pending prompts", async () => {
  const { dir, env, files } = await seed();
  try {
    const home = cli([], env);
    assert.equal(home.status, 0, home.stderr);
    assert.ok(home.stdout.includes(files.open), "an open session stays listed");
    assert.ok(!home.stdout.includes(files.drainedEnd), "an ended session with nothing pending stays hidden");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pending lists every session with undelivered prompts, ended ones included", async () => {
  const { dir, env, files } = await seed();
  try {
    const pending = cli(["pending"], env);
    assert.equal(pending.status, 0, `${pending.stdout}${pending.stderr}`);
    assert.ok(pending.stdout.includes(files.strandedEnd), pending.stdout);
    assert.match(pending.stdout, /skip today/);
    assert.match(pending.stdout, /ended/);
    assert.ok(!pending.stdout.includes(files.open), "a session with nothing pending is not listed");
    assert.ok(!pending.stdout.includes(files.drainedEnd), "a drained ended session is not listed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pending output names the listener and never suggests a takeover", async () => {
  const { createPendingOutput } = await import("../src/cli.js");
  const output = createPendingOutput([
    {
      file: "/a.html",
      status: "feedback",
      listener: "lavish-poll-loop",
      prompts: [prompt("first")],
      pending_prompts: 1,
    },
    {
      file: "/b.html",
      status: "ended",
      ended_by: "user",
      listener: "none",
      prompts: [prompt("second"), prompt("third")],
      pending_prompts: 2,
    },
  ]);

  assert.deepEqual(
    output.sessions.map((s) => [s.file, s.status, s.listener, s.pending_prompts]),
    [
      ["/a.html", "feedback", "lavish-poll-loop", 1],
      ["/b.html", "ended", "none", 2],
    ],
  );
  assert.equal(output.sessions[1].ended_by, "user");
  assert.deepEqual(
    output.sessions[1].prompts.map((p) => p.prompt),
    ["second", "third"],
  );
  assert.doesNotMatch(output.next_step, /--takeover/);
  assert.match(output.next_step, /lavish-axi poll/);

  const empty = createPendingOutput([]);
  assert.deepEqual(empty.sessions, []);
  assert.match(empty.next_step, /No undelivered prompts/);
});
