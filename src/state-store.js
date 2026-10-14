// The shared item store for one directory of artifacts (docs/shared-state.md).
//
// Several static pages often describe the same things - a PR, a ticket, a question. Each page
// baked its own copy, so one going stale left every other page wrong. The store is the single
// source: `<pagesDir>/.lavish/state.json`, written atomically by the CLI or the server, watched by
// the server, and pushed to every open page whose artifact lives in that directory.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import chokidar from "chokidar";

export const STATE_VERSION = 1;
export const DEFAULT_STALE_AFTER_HOURS = 24;
// `<kind>:<rest>`: pr:<owner>/<repo>#<n>, ticket:<KEY>, worker:<name>, q:<question-id>. The rest may
// hold inner spaces, because question ids are copied verbatim from page attributes; it may not
// start or end with whitespace or contain control characters.
const ITEM_ID_PATTERN = /^(pr|ticket|worker|q):\S(?:\P{Cc}*\S)?$/u;
const FIELD_PATTERN = /^[A-Za-z][\w-]{0,63}$/;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export function stateFilePath(dir) {
  return path.join(path.resolve(dir), ".lavish", "state.json");
}

export function isStateDisabled(env = process.env) {
  return (
    String(env.LAVISH_STATE || "")
      .trim()
      .toLowerCase() === "off"
  );
}

export function isValidItemId(id) {
  return typeof id === "string" && id.length <= 256 && ITEM_ID_PATTERN.test(id);
}

export function emptyState() {
  return { version: STATE_VERSION, staleAfterHours: DEFAULT_STALE_AFTER_HOURS, items: {} };
}

// Read leniently, write strictly: a hand-edited file with a number where a string belongs still
// renders, and a malformed item is dropped instead of taking every other item down with it.
export function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
  const hours = Number(raw.staleAfterHours);
  if (Number.isFinite(hours) && hours > 0) state.staleAfterHours = hours;
  const items = raw.items && typeof raw.items === "object" && !Array.isArray(raw.items) ? raw.items : {};
  for (const [id, item] of Object.entries(items)) {
    if (!isValidItemId(id) || !item || typeof item !== "object" || Array.isArray(item)) continue;
    /** @type {Record<string, string>} */
    const fields = {};
    for (const [field, value] of Object.entries(item)) {
      if (!FIELD_PATTERN.test(field)) continue;
      if (typeof value === "string") fields[field] = value;
      else if (typeof value === "number" || typeof value === "boolean") fields[field] = String(value);
    }
    state.items[id] = fields;
  }
  return state;
}

/** @returns {Promise<ReturnType<typeof emptyState>>} */
export async function readState(dir) {
  let text;
  try {
    text = await readFile(stateFilePath(dir), "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return emptyState();
    throw error;
  }
  try {
    return normalizeState(JSON.parse(text));
  } catch (error) {
    throw new Error(`${stateFilePath(dir)} is not valid JSON`, { cause: error });
  }
}

// `key=value` assignments from the CLI. `updatedAt` is stamped by the write, so it is refused here.
export function parseAssignments(pairs) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const pair of pairs) {
    const at = String(pair).indexOf("=");
    if (at <= 0) throw new Error(`expected key=value, got "${pair}"`);
    const field = pair.slice(0, at);
    if (!FIELD_PATTERN.test(field)) throw new Error(`invalid field name "${field}"`);
    if (field === "updatedAt") throw new Error("updatedAt is stamped by the write and cannot be set");
    fields[field] = pair.slice(at + 1);
  }
  return fields;
}

/**
 * Merge `fields` into item `id`, stamp `updatedAt` and `source`, and write the file atomically.
 * @param {string} dir
 * @param {string} id
 * @param {Record<string, string>} fields
 * @param {{ source?: string, now?: Date }} [options]
 */
export async function setItem(dir, id, fields, { source = "captain", now = new Date() } = {}) {
  if (!isValidItemId(id)) throw new Error(`invalid item id "${id}"; use pr:, ticket:, worker: or q:`);
  for (const [field, value] of Object.entries(fields)) {
    if (!FIELD_PATTERN.test(field) || typeof value !== "string") throw new Error(`invalid field "${field}"`);
  }
  return withStateLock(dir, async () => {
    const state = await readState(dir);
    const item = {
      ...state.items[id],
      ...fields,
      updatedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      source: String(source || "captain"),
    };
    state.items[id] = item;
    await writeStateAtomic(dir, state);
    return item;
  });
}

export async function writeStateAtomic(dir, state) {
  const file = stateFilePath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

// Atomic rename keeps a reader from ever seeing half a file; this lock keeps two writers (the CLI
// and the server's answer route) from losing each other's read-modify-write. A lock directory
// older than LOCK_STALE_MS belongs to a writer that died and is taken over.
async function withStateLock(dir, fn) {
  const lock = `${stateFilePath(dir)}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      const held = await stat(lock).catch(() => null);
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await rmdir(lock).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

// Modification times of the page files in `dir`, so a page can tell that an item's source page
// was edited after the item was last written (`data-lavish-stale="source"`).
export async function pageMtimes(dir) {
  /** @type {Record<string, string>} */
  const mtimes = {};
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
      .map(async (entry) => {
        const info = await stat(path.join(dir, entry.name)).catch(() => null);
        if (info) mtimes[entry.name] = info.mtime.toISOString();
      }),
  );
  return mtimes;
}

/** The payload a page renders from: the store plus the page-file mtimes. */
export async function stateSnapshot(dir) {
  const [state, mtimes] = await Promise.all([readState(dir), pageMtimes(dir)]);
  return { state, pageMtimes: mtimes };
}

/**
 * Watch the store file and the page files of `dir`; `onChange` fires debounced.
 * @param {string} dir
 * @param {() => void} onChange
 * @param {{ debounceMs?: number, onError?: (error: unknown) => void }} [options]
 */
export function watchStateDir(dir, onChange, { debounceMs = 50, onError } = {}) {
  const root = path.resolve(dir);
  const storeDir = path.join(root, ".lavish");
  const relevant = (file) => {
    const resolved = path.resolve(file);
    if (resolved === root || resolved === storeDir) return true;
    if (path.dirname(resolved) === storeDir) return path.basename(resolved) === "state.json";
    return path.dirname(resolved) === root && /\.html?$/i.test(resolved);
  };
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    depth: 1,
    ignored: (file) => !relevant(file),
  });
  let timer = null;
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  if (onError) watcher.on("error", onError);
  return {
    async close() {
      clearTimeout(timer);
      await watcher.close();
    },
  };
}
