import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openCommandFromEnv, openReviewUrl } from "../src/browser-open.js";

async function withScript(body, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-open-"));
  const script = path.join(dir, "opener.sh");
  await writeFile(script, `#!/bin/sh\n${body}\n`);
  await chmod(script, 0o755);
  try {
    await fn({ dir, script });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the open command receives the URL as one literal argument after its own", async () => {
  await withScript('printf "%s\\n" "$@" > "$(dirname "$0")/args"', async ({ dir, script }) => {
    const url = "http://mac.tail.ts.net:4387/session/abc?x=1&y=$(touch pwned)";
    const result = await openReviewUrl(url, { LAVISH_AXI_OPEN_COMMAND: `${script} open` });
    assert.deepEqual(result, { ok: true });
    assert.equal(await readFile(path.join(dir, "args"), "utf8"), `open\n${url}\n`);
  });
});

test("a failing open command is reported with its reason and the machine label", async () => {
  await withScript('echo "bridge: Mac unreachable" >&2; exit 3', async ({ script }) => {
    const result = await openReviewUrl("http://x/session/1", {
      LAVISH_AXI_OPEN_COMMAND: script,
      LAVISH_AXI_OPEN_LABEL: "Mac",
    });
    assert.deepEqual(result, { ok: false, error: "could not open on Mac: bridge: Mac unreachable" });
  });
  await withScript("exit 4", async ({ script }) => {
    const result = await openReviewUrl("http://x/session/1", { LAVISH_AXI_OPEN_COMMAND: script });
    assert.equal(result.ok, false);
    assert.match("error" in result ? result.error : "", /^could not open on the viewer's machine: .*exited with 4$/);
  });
  const missing = await openReviewUrl("http://x/session/1", { LAVISH_AXI_OPEN_COMMAND: "/nonexistent/opener" });
  assert.match("error" in missing ? missing.error : "", /^could not open on the viewer's machine: .*ENOENT/);
});

test("without an open command the local opener runs, and its failure is reported too", async () => {
  /** @type {string[]} */
  const opened = [];
  const ok = await openReviewUrl("http://x/1", {}, { local: async (url) => void opened.push(url) });
  assert.deepEqual([ok, opened], [{ ok: true }, ["http://x/1"]]);
  const failed = await openReviewUrl(
    "http://x/1",
    {},
    {
      local: async () => {
        throw new Error("no display");
      },
    },
  );
  assert.deepEqual(failed, { ok: false, error: "could not open on this machine: no display" });
});

test("a blank open command means none", () => {
  assert.equal(openCommandFromEnv({ LAVISH_AXI_OPEN_COMMAND: "   " }), null);
  assert.deepEqual(openCommandFromEnv({ LAVISH_AXI_OPEN_COMMAND: " mac-worker  open " }), ["mac-worker", "open"]);
});
