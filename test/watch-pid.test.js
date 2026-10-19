import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const watchModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/watch.js");
const STARTERS = 10;
const ROUNDS = 10;

// Each child spins until the shared start time, claims once, prints the result, and stays alive
// long enough that a winner's pid is still live while the others decide.
const child = `
import { claimWatchPid } from ${JSON.stringify(watchModule)};
const [dir, at] = process.argv.slice(1);
while (Date.now() < Number(at));
const won = claimWatchPid(dir);
process.stdout.write(won ? "won" : "lost");
setTimeout(() => {}, 1000);
`;

async function race(dir) {
  const at = Date.now() + 400;
  const results = await Promise.all(
    Array.from({ length: STARTERS }, () => {
      const proc = spawn(process.execPath, ["--input-type=module", "-e", child, dir, String(at)], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let out = "";
      proc.stdout.on("data", (chunk) => (out += chunk));
      return new Promise((resolve) => proc.on("exit", () => resolve({ pid: proc.pid, out })));
    }),
  );
  return results;
}

test("ten watchers started at once: exactly one claims the pidfile, every round", async () => {
  for (let round = 0; round < ROUNDS; round += 1) {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-watch-pid-"));
    try {
      const results = await race(dir);
      const winners = results.filter((result) => result.out === "won");
      assert.equal(winners.length, 1, `round ${round}: ${winners.length} winners`);
      assert.equal(Number(readFileSync(path.join(dir, "watch.pid"), "utf8")), winners[0].pid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a pidfile left by a dead watcher is reclaimed by exactly one of ten starters", async () => {
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  for (let round = 0; round < ROUNDS; round += 1) {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-watch-pid-"));
    try {
      writeFileSync(path.join(dir, "watch.pid"), String(dead));
      const results = await race(dir);
      const winners = results.filter((result) => result.out === "won");
      assert.equal(winners.length, 1, `round ${round}: ${winners.length} winners`);
      assert.equal(Number(readFileSync(path.join(dir, "watch.pid"), "utf8")), winners[0].pid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
