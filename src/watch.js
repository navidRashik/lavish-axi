import {
  appendFileSync,
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// One process holds the long-poll listener of every page in a watch list. Each page costs one idle
// socket on the server instead of its own node process. The list is append-only: `+<page>\t<name>`
// lines, read from the last offset, so an add never races a rewrite. A page leaves the active set
// when its session ends or disappears; the process exits once no page is active.

export const WATCH_LIST = "watch.list";
export const WATCH_PID = "watch.pid";

const utc = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function parseWatchLines(text) {
  const pages = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("+")) continue;
    const [file, name] = line.slice(1).split("\t");
    if (file) pages.push({ file, name: name || path.basename(file, ".html") });
  }
  return pages;
}

export function appendWatchLine(feedDir, file, name) {
  mkdirSync(feedDir, { recursive: true });
  // One short O_APPEND write is atomic against other appenders.
  appendFileSync(path.join(feedDir, WATCH_LIST), `+${file}\t${name || path.basename(file, ".html")}\n`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const RECLAIM_LOCK_STALE_MS = 10_000;

/** Claims the watcher pidfile; false when a live watcher already holds it. */
export function claimWatchPid(feedDir, pid = process.pid) {
  const file = path.join(feedDir, WATCH_PID);
  // link() publishes a pidfile that already holds its pid, so no reader ever sees it empty, and it
  // fails with EEXIST instead of replacing a file another claimant just published.
  const staged = `${file}.${pid}.tmp`;
  writeFileSync(staged, String(pid));
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(staged, file);
        return true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (!removeDeadPidfile(file)) return false;
    }
    return false;
  } finally {
    rmSync(staged, { force: true });
  }
}

// Removes the pidfile only when the pid it records is dead, and only that exact file: reclaimers
// run one at a time under a mkdir lock and unlink only if the inode they read is still in place.
// A dead holder never releases and a present pidfile blocks every link(), so nothing else can swap
// the file between the check and the unlink. True means the pidfile is gone and a link may retry.
function removeDeadPidfile(file) {
  const lock = `${file}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(lock).mtimeMs > RECLAIM_LOCK_STALE_MS) rmdirSync(lock);
    } catch {
      // The lock was released meanwhile.
    }
    return false;
  }
  try {
    let fd;
    try {
      fd = openSync(file, "r");
    } catch {
      return true;
    }
    let inode;
    let holder;
    try {
      inode = fstatSync(fd).ino;
      holder = Number(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
    if (holder > 0 && pidAlive(holder)) return false;
    if (statSync(file, { throwIfNoEntry: false })?.ino === inode) unlinkSync(file);
    return true;
  } finally {
    rmdirSync(lock);
  }
}

export function watcherRunning(feedDir) {
  try {
    const holder = Number(readFileSync(path.join(feedDir, WATCH_PID), "utf8"));
    return Boolean(holder) && pidAlive(holder);
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   feedDir: string,
 *   poll: (file: string, signal: AbortSignal) => Promise<any>,
 *   render: (file: string, response: any) => string | Promise<string>,
 *   retryMs?: number, fastFailMs?: number, fastFailWaitMs?: number, listCheckMs?: number,
 * }} options
 */
export async function runWatch({
  feedDir,
  poll,
  render,
  retryMs = 30_000,
  fastFailMs = 3_000,
  fastFailWaitMs = 5_000,
  listCheckMs = 60_000,
}) {
  const listFile = path.join(feedDir, WATCH_LIST);
  const active = new Map();
  const stop = new AbortController();
  let offset = 0;
  let seen = 0;
  let wake = null;

  const note = (name, text) => appendFileSync(path.join(feedDir, `${name}.log`), `=== ${utc()} · ${text}\n`);
  const sleep = (ms) => {
    const { promise, resolve } = Promise.withResolvers();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      stop.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    stop.signal.addEventListener("abort", onAbort, { once: true });
    return promise;
  };

  async function watchPage(file, name) {
    note(name, `watch start pid=${process.pid} page=${file}`);
    while (!stop.signal.aborted) {
      const started = Date.now();
      let ended;
      try {
        const response = await poll(file, stop.signal);
        const body = await render(file, response);
        const kind = response.status === "feedback" ? "delivery" : "return";
        const seconds = Math.round((Date.now() - started) / 1000);
        appendFileSync(
          path.join(feedDir, `${name}.log`),
          `\n=== ${utc()} · ${kind} (rc=0, ${seconds}s)\n${body}=== end ${kind}\n`,
        );
        ended = response.session_ended === true || response.status === "ended" || response.status === "missing";
        if (ended) note(name, `session ended (ended_by: ${response.ended_by || "?"}); page leaves the watch`);
      } catch (error) {
        if (stop.signal.aborted) break;
        if (error?.code === "LISTENER_ACTIVE") {
          note(name, `LISTENER_ACTIVE (another listener holds the page; retry in ${retryMs / 1000}s)`);
          await sleep(retryMs);
          continue;
        }
        ended = error?.code === "NOT_FOUND" || error?.code === "LISTENER_REPLACED";
        note(name, `${error?.code || "ERROR"}: ${error?.message || error}${ended ? "; page leaves the watch" : ""}`);
      }
      if (ended) break;
      if (Date.now() - started < fastFailMs) await sleep(fastFailWaitMs);
    }
    active.delete(file);
    wake?.();
  }

  function readNewLines() {
    let size;
    try {
      size = statSync(listFile).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = openSync(listFile, "r");
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    closeSync(fd);
    const text = buffer.toString("utf8");
    const complete = text.lastIndexOf("\n") + 1;
    offset += Buffer.byteLength(text.slice(0, complete));
    for (const { file, name } of parseWatchLines(text.slice(0, complete))) {
      seen += 1;
      if (!active.has(file)) active.set(file, watchPage(file, name));
    }
  }

  const listGrew = () => {
    try {
      return statSync(listFile).size > offset;
    } catch {
      return false;
    }
  };

  const onSignal = () => stop.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // A new list line wakes the loop at once; the timer only covers a lost filesystem event.
  const listWatcher = watch(feedDir, (_event, name) => {
    if (name === WATCH_LIST) wake?.();
  });
  try {
    for (;;) {
      readNewLines();
      if (active.size === 0 || stop.signal.aborted) {
        // Release, then look once more: an add that landed before the release is picked up here,
        // and an add after it finds no pidfile and starts a fresh watcher.
        try {
          unlinkSync(path.join(feedDir, WATCH_PID));
        } catch {
          // Already gone.
        }
        if (stop.signal.aborted || !listGrew() || !claimWatchPid(feedDir)) break;
        continue;
      }
      const { promise, resolve } = Promise.withResolvers();
      wake = resolve;
      const timer = setTimeout(resolve, listCheckMs);
      await promise;
      clearTimeout(timer);
      wake = null;
    }
    await Promise.allSettled(active.values());
  } finally {
    listWatcher.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return { pages_seen: seen };
}
