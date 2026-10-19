#!/usr/bin/env node
// Measures what idle `lavish-axi poll` listeners cost: resident memory and CPU per process.
// Everything runs against a throwaway server on a free port with its own state directory, so a
// live Lavish server and its sessions are never touched.
//
//   node scripts/measure-poll-footprint.js [--cli dist/cli.mjs] [--polls 5] [--window-ms 10000]
//
// Prints one JSON object: rss_mb per poll process (min/median/max), cpu_pct summed over all polls
// during the window, and the server's own rss_mb.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const cli = path.resolve(arg("--cli", "dist/cli.mjs"));
const polls = Number(arg("--polls", "5"));
const windowMs = Number(arg("--window-ms", "10000"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
const dir = mkdtempSync(path.join(os.tmpdir(), "lavish-poll-footprint-"));
const env = {
  ...process.env,
  LAVISH_AXI_STATE_DIR: path.join(dir, "state"),
  LAVISH_AXI_PORT: String(port),
  LAVISH_AXI_HOST: "127.0.0.1",
  LAVISH_AXI_TELEMETRY: "0",
};
const children = [];
const start = (args) => {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: "ignore" });
  children.push(child);
  return child;
};

// cpu_ms is user+system time; ps reports it as [[dd-]hh:]mm:ss.cc on both Linux and macOS.
function sample(pids) {
  const out = execFileSync("ps", ["-o", "pid=,rss=,time=", "-p", pids.join(",")], { encoding: "utf8" });
  const rows = new Map();
  for (const line of out.trim().split("\n")) {
    const [pid, rss, time] = line.trim().split(/\s+/);
    const parts = time.replace("-", ":").split(":").map(Number);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    rows.set(Number(pid), { rssMb: Number(rss) / 1024, cpuMs: seconds * 1000 });
  }
  return rows;
}

// PSS charges shared pages (the node binary, libc) pro rata, so N polls sum to their real cost.
// Linux only; elsewhere it is null.
function pssMb(pid) {
  try {
    const kb = /^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1];
    return kb ? Number(kb) / 1024 : null;
  } catch {
    return null;
  }
}

try {
  const server = start(["server", "--port", String(port)]);
  for (let i = 0; ; i += 1) {
    if (i > 100) throw new Error("server did not become healthy");
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    await sleep(100);
  }
  const pollers = [];
  for (let i = 0; i < polls; i += 1) {
    const file = path.join(dir, `page-${i}.html`);
    writeFileSync(file, `<!doctype html><title>footprint ${i}</title><p>page ${i}</p>`);
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });
    if (!response.ok) throw new Error(`session ${i}: HTTP ${response.status}`);
    pollers.push(start(["poll", file, "--owner", "footprint"]));
  }
  await sleep(3000);
  const pids = pollers.map((child) => child.pid);
  const before = sample([...pids, server.pid]);
  await sleep(windowMs);
  const after = sample([...pids, server.pid]);
  if (pids.some((pid) => !after.has(pid))) throw new Error("a poll process exited during the window");
  const rss = pids.map((pid) => after.get(pid).rssMb).sort((a, b) => a - b);
  const cpuMs = pids.reduce((total, pid) => total + after.get(pid).cpuMs - before.get(pid).cpuMs, 0);
  const round = (value) => Math.round(value * 10) / 10;
  console.log(
    JSON.stringify({
      cli,
      node: process.version,
      polls,
      window_ms: windowMs,
      poll_rss_mb: { min: round(rss[0]), median: round(rss[Math.floor(rss.length / 2)]), max: round(rss.at(-1)) },
      poll_rss_mb_total: round(rss.reduce((total, value) => total + value, 0)),
      poll_pss_mb_total: pids.every((pid) => pssMb(pid) !== null)
        ? round(pids.reduce((total, pid) => total + pssMb(pid), 0))
        : null,
      poll_cpu_pct_total: round((100 * cpuMs) / windowMs),
      server_rss_mb: round(after.get(server.pid).rssMb),
    }),
  );
} finally {
  for (const child of children) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
