import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fork-update.sh");

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// A clone of a one-commit origin, checked out on a feature branch, and a fake npm that reports a
// global root inside the fixture and records every other call.
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fork-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, repo);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "checkout", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-q", "-b", "feature");

  const bin = path.join(dir, "bin");
  const globalRoot = path.join(dir, "global");
  const calls = path.join(dir, "npm-calls.log");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "npm"),
    `#!/usr/bin/env bash\nif [ "$1 $2" = "root -g" ]; then echo ${JSON.stringify(globalRoot)}; exit 0; fi\necho "$*" >> ${JSON.stringify(calls)}\n`,
  );
  chmodSync(path.join(bin, "npm"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    LAVISH_FORK_REPO: repo,
    LAVISH_NPM: "npm",
    LAVISH_SKILL_DEST: path.join(dir, "skills", "lavish", "SKILL.md"),
    LAVISH_FORK_STATE: path.join(dir, "state", "fork-installed-sha"),
  };
  const run = (...args) => spawnSync("bash", [SCRIPT, ...args], { env, encoding: "utf8" });
  const npmCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);
  return { dir, repo, globalRoot, env, run, npmCalls };
}

test("--dry-run fetches and reports every step without switching, building, installing or recording", (t) => {
  const f = fixture(t);
  const r = f.run("--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\] would run: git switch --quiet main/);
  assert.match(r.stdout, /\[dry-run\] would run: npm i -g <tmpdir>\/lavish-axi-<version>\.tgz/);
  assert.equal(git(f.repo, "symbolic-ref", "--short", "HEAD"), "feature");
  assert.deepEqual(f.npmCalls(), []);
  assert.equal(existsSync(f.env.LAVISH_FORK_STATE), false);
  assert.equal(existsSync(f.env.LAVISH_SKILL_DEST), false);
});

test("an install already at origin/main skips the build and only refreshes SKILL.md", (t) => {
  const f = fixture(t);
  const pkg = path.join(f.globalRoot, "lavish-axi");
  mkdirSync(path.join(pkg, "skills", "lavish"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), '{"version":"9.9.9"}');
  writeFileSync(path.join(pkg, "skills", "lavish", "SKILL.md"), "# lavish\n");
  mkdirSync(path.dirname(f.env.LAVISH_FORK_STATE));
  writeFileSync(f.env.LAVISH_FORK_STATE, `${git(f.repo, "rev-parse", "origin/main")}\n`);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already installed; skipping build and install/);
  assert.deepEqual(f.npmCalls(), []);
  assert.equal(git(f.repo, "symbolic-ref", "--short", "HEAD"), "feature");
  assert.equal(readFileSync(f.env.LAVISH_SKILL_DEST, "utf8"), "# lavish\n");
});

test("a clone with local changes is refused before any switch or build", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.repo, "README.md"), "edited\n");
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has local changes; refusing to switch or build/);
  assert.equal(git(f.repo, "symbolic-ref", "--short", "HEAD"), "feature");
  assert.deepEqual(f.npmCalls(), []);
});
