import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readState } from "../src/state-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function cli(args, env) {
  return spawnSync(process.execPath, [path.join(repoRoot, "bin/lavish-axi.js"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("state set, get and list round-trip through the directory's store", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-cli-state-"));
  const env = { LAVISH_AXI_STATE_DIR: path.join(dir, "lavish-home"), LAVISH_AXI_TELEMETRY: "0" };
  try {
    const set = cli(
      ["state", "set", "pr:x/y#1", "status=merged", "review=none", "--dir", dir, "--source", "github"],
      env,
    );
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /status: merged/);
    const item = (await readState(dir)).items["pr:x/y#1"];
    assert.equal(item.review, "none");
    assert.equal(item.source, "github");
    assert.ok(Date.parse(item.updatedAt));

    const get = cli(["state", "get", "pr:x/y#1", "--dir", dir], env);
    assert.equal(get.status, 0, get.stderr);
    assert.match(get.stdout, /review: none/);

    const list = cli(["state", "list", "--dir", dir], env);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /pr:x\/y#1/);

    const bad = cli(["state", "set", "nope", "status=x", "--dir", dir], env);
    assert.notEqual(bad.status, 0);
    assert.match(`${bad.stdout}${bad.stderr}`, /invalid item id/);
    const missing = cli(["state", "get", "ticket:NONE-1", "--dir", dir], env);
    assert.notEqual(missing.status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
