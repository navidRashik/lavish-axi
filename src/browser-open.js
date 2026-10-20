import { spawn } from "node:child_process";

// `lavish-axi <file>` opens the review page for the person reading it. When the CLI runs on a
// server that person is not sitting at, LAVISH_AXI_OPEN_COMMAND names a command that opens a URL
// on their machine instead (for example a bridge that runs `open <url>` on a Mac); the URL is
// appended as its final argument and nothing goes through a shell. A failure is reported, never
// swallowed, so the agent can hand the URL over by hand.

const OPEN_COMMAND_TIMEOUT_MS = 60_000;

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[] | null}
 */
export function openCommandFromEnv(env) {
  const argv = String(env.LAVISH_AXI_OPEN_COMMAND || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return argv.length ? argv : null;
}

/**
 * Run `argv... url` and resolve when it exits 0; reject with its stderr (or exit code) otherwise.
 * @param {string[]} argv
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export function runOpenCommand(argv, url, timeoutMs = OPEN_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], [...argv.slice(1), url], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${argv[0]} did not finish within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split("\n").pop() || `${argv[0]} exited with ${code ?? signal}`));
    });
  });
}

async function openLocally(url) {
  const open = (await import("open")).default;
  await open(url);
}

/**
 * @param {string} url
 * @param {NodeJS.ProcessEnv} env
 * @param {{ run?: typeof runOpenCommand, local?: (url: string) => Promise<void> }} [deps]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function openReviewUrl(url, env, { run = runOpenCommand, local = openLocally } = {}) {
  const argv = openCommandFromEnv(env);
  const where = String(env.LAVISH_AXI_OPEN_LABEL || "").trim() || (argv ? "the viewer's machine" : "this machine");
  try {
    if (argv) await run(argv, url);
    else await local(url);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not open on ${where}: ${reason || "unknown error"}` };
  }
}
