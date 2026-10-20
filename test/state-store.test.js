import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isStateDisabled,
  isValidItemId,
  normalizeState,
  pageMtimes,
  parseAssignments,
  readState,
  setItem,
  stateFilePath,
  stateSnapshot,
  watchStateDir,
} from "../src/state-store.js";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "lavish-state-"));
}

test("item ids follow the four documented kinds", () => {
  for (const id of [
    "pr:acme/app#123",
    "ticket:ACME-42",
    "worker:hub-refresh",
    "q:merge-now",
    "q:ACME-77 Q1 (behaviour): which default applies",
  ]) {
    assert.equal(isValidItemId(id), true, id);
  }
  for (const id of ["", "pr:", "issue:1", "pr: spaced", "q:a ", "q:a\nb", "q:\u0000", "q:a\u0000", 42]) {
    assert.equal(isValidItemId(id), false, String(id));
  }
});

test("a question id copied verbatim from a page attribute survives a read", () => {
  const id = "q:ACME-77 Q1 (behaviour): which default applies";
  const state = normalizeState({ version: 1, items: { [id]: { status: "answered", answer: "fail closed" } } });
  assert.equal(state.items[id]?.answer, "fail closed");
});

test("a missing store reads as an empty version-1 store", async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual(await readState(dir), { version: 1, staleAfterHours: 24, items: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizeState keeps the contract shape and drops what it cannot render", () => {
  const state = normalizeState({
    version: 1,
    staleAfterHours: 6,
    items: {
      "pr:x/y#1": { status: "merged", count: 3, ok: true, nested: { no: 1 }, "bad key": "x" },
      "bogus:1": { status: "open" },
      "ticket:A-1": "not an object",
    },
  });
  assert.deepEqual(state, {
    version: 1,
    staleAfterHours: 6,
    items: { "pr:x/y#1": { status: "merged", count: "3", ok: "true" } },
  });
});

test("the store reads the sibling-seeded contract file as-is", async () => {
  const dir = await tempDir();
  try {
    const seeded = {
      version: 1,
      staleAfterHours: 24,
      items: {
        "pr:acme/app#123": {
          status: "merged",
          title: "Lock fix",
          url: "https://github.com/acme/app/pull/123",
          updatedAt: "2026-10-14T15:00:00Z",
          source: "github",
        },
      },
    };
    await mkdir(path.join(dir, ".lavish"));
    await writeFile(stateFilePath(dir), JSON.stringify(seeded));
    assert.deepEqual(await readState(dir), seeded);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt store is an error, not a silently empty store", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, ".lavish"));
    await writeFile(stateFilePath(dir), "{ not json");
    await assert.rejects(readState(dir), /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setItem merges fields, stamps updatedAt and source, and leaves no temp file", async () => {
  const dir = await tempDir();
  try {
    await setItem(dir, "pr:x/y#1", { status: "open", title: "First" }, { now: new Date("2026-10-14T10:00:00.123Z") });
    const item = await setItem(
      dir,
      "pr:x/y#1",
      { status: "merged" },
      {
        source: "github",
        now: new Date("2026-10-14T11:00:00Z"),
      },
    );
    assert.deepEqual(item, { status: "merged", title: "First", updatedAt: "2026-10-14T11:00:00Z", source: "github" });
    const onDisk = JSON.parse(await readFile(stateFilePath(dir), "utf8"));
    assert.deepEqual(onDisk.items["pr:x/y#1"], item);
    assert.deepEqual(await readdir(path.join(dir, ".lavish")), ["state.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent writers do not lose each other's fields", async () => {
  const dir = await tempDir();
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => setItem(dir, `worker:w${index}`, { status: "running" })),
    );
    assert.equal(Object.keys((await readState(dir)).items).length, 12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setItem refuses an invalid id", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(setItem(dir, "nope", { status: "x" }), /invalid item id/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseAssignments reads key=value and refuses updatedAt", () => {
  assert.deepEqual(parseAssignments(["status=merged", "title=a=b", "empty="]), {
    status: "merged",
    title: "a=b",
    empty: "",
  });
  assert.throws(() => parseAssignments(["status"]), /key=value/);
  assert.throws(() => parseAssignments(["updatedAt=now"]), /stamped/);
  assert.throws(() => parseAssignments(["bad key=x"]), /invalid field/);
});

test("LAVISH_STATE=off is the server kill switch", () => {
  assert.equal(isStateDisabled({ LAVISH_STATE: "off" }), true);
  assert.equal(isStateDisabled({ LAVISH_STATE: " OFF " }), true);
  assert.equal(isStateDisabled({}), false);
});

test("stateSnapshot carries the page-file modification times", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "index.html"), "<p>hi</p>");
    await writeFile(path.join(dir, "notes.txt"), "not a page");
    const when = new Date("2026-10-14T12:00:00Z");
    await utimes(path.join(dir, "index.html"), when, when);
    assert.deepEqual(await pageMtimes(dir), { "index.html": "2026-10-14T12:00:00.000Z" });
    const snapshot = await stateSnapshot(dir);
    assert.deepEqual(Object.keys(snapshot), ["state", "pageMtimes"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchStateDir fires when the store is written, including its first creation", async () => {
  const dir = await tempDir();
  let fired = 0;
  const watcher = watchStateDir(dir, () => (fired += 1), { debounceMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await setItem(dir, "ticket:A-1", { status: "In Progress" });
    const deadline = Date.now() + 5000;
    while (fired === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(fired > 0, "store write was observed");
  } finally {
    await watcher.close();
    await rm(dir, { recursive: true, force: true });
  }
});
