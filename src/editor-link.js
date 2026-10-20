import { realpath, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";

import { localInterfaceAddresses } from "./local-address.js";

// "Open in editor" is resolved by the server and launched by the viewer's browser: the server
// turns a page-named path into a real, root-confined absolute path and returns a `vscode://`
// URI, and the chrome navigates to it so VS Code opens on the machine the reviewer is sitting
// at. When that machine is not the server host, the URI goes through Remote-SSH, so nothing
// runs on the server and no editor needs to exist there.

/**
 * Directories a page may open files under. LAVISH_EDITOR_ROOTS lists them separated by the
 * platform path delimiter; unset or empty means the server user's home directory.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string[]}
 */
export function resolveEditorRoots(env = process.env, home = homedir()) {
  const raw = String(env.LAVISH_EDITOR_ROOTS || "").trim();
  const roots = raw
    ? raw
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => entry && path.isAbsolute(entry))
    : [home];
  return [...new Set(roots.map((entry) => path.resolve(entry)))];
}

/**
 * The SSH host alias the viewer's VS Code uses to reach this server (LAVISH_EDITOR_SSH_HOST),
 * falling back to this machine's hostname.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveEditorSshHost(env = process.env) {
  return String(env.LAVISH_EDITOR_SSH_HOST || "").trim() || hostname();
}

/**
 * True only when the browser runs on this machine: the connection comes from loopback or one of
 * this machine's addresses AND the page was opened under a name of this machine. Both are needed
 * because an SSH port forward delivers a remote viewer's request over loopback, under the
 * forwarding machine's hostname.
 * @param {{ remoteAddress?: string, hostname?: string | null }} request
 * @param {{ localAddresses?: string[], ownHostnames?: string[] }} [machine]
 */
export function isLocalViewer(
  { remoteAddress, hostname: requestHost },
  { localAddresses = localInterfaceAddresses(), ownHostnames = [hostname()] } = {},
) {
  const address = String(remoteAddress || "").replace(/^::ffff:/i, "");
  const loopbackAddress = address === "::1" || /^127\./.test(address);
  if (!loopbackAddress && !localAddresses.includes(address)) return false;
  const name = String(requestHost || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!name) return false;
  if (name === "localhost" || name === "::1" || /^127\./.test(name)) return true;
  return localAddresses.includes(name) || ownHostnames.some((own) => own.toLowerCase() === name);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathOrNull(value) {
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

/**
 * Resolve a page-supplied file reference to a real absolute path confined to an allowed root.
 * A relative `file` needs an absolute `root`; both the root and the final real path (symlinks
 * followed) must sit inside one of `roots`, and the target must be an existing regular file.
 * @param {{ file?: unknown, root?: unknown }} request
 * @param {{ roots: string[] }} options
 * @returns {Promise<{ ok: true, path: string } | { ok: false, error: string }>}
 */
export async function resolveEditorPath({ file, root }, { roots }) {
  const fileText = typeof file === "string" ? file.trim() : "";
  const rootText = typeof root === "string" ? root.trim() : "";
  if (!fileText || fileText.includes("\0") || rootText.includes("\0")) return { ok: false, error: "no file named" };
  const realRoots = (await Promise.all(roots.map(realpathOrNull))).filter((entry) => entry !== null);
  if (realRoots.length === 0) return { ok: false, error: "no editor root exists on this server" };

  let candidate;
  if (path.isAbsolute(fileText)) {
    candidate = path.resolve(fileText);
  } else {
    if (!rootText) return { ok: false, error: "a relative path needs a root (data-lavish-root)" };
    if (!path.isAbsolute(rootText)) return { ok: false, error: "the root must be an absolute path" };
    const realRoot = await realpathOrNull(rootText);
    if (!realRoot) return { ok: false, error: "the root does not exist" };
    if (!realRoots.some((allowed) => isInside(allowed, realRoot))) {
      return { ok: false, error: "the root is outside the allowed editor roots" };
    }
    candidate = path.resolve(realRoot, fileText);
    if (!isInside(realRoot, candidate)) return { ok: false, error: "the path escapes its root" };
  }

  const real = await realpathOrNull(candidate);
  if (!real) return { ok: false, error: "the file does not exist" };
  if (!realRoots.some((allowed) => isInside(allowed, real))) {
    return { ok: false, error: "the file is outside the allowed editor roots" };
  }
  if (!(await stat(real)).isFile()) return { ok: false, error: "the path is not a file" };
  return { ok: true, path: real };
}

function encodePath(absolutePath) {
  return absolutePath
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Build the URI VS Code registers for. `sshHost` set means the file lives on that Remote-SSH
 * host; unset means it is on the viewer's own machine.
 * @param {string} absolutePath
 * @param {{ sshHost?: string, line?: unknown }} [options]
 */
export function buildEditorUri(absolutePath, { sshHost = "", line } = {}) {
  if (!path.isAbsolute(absolutePath)) throw new Error("editor URI needs an absolute path");
  const lineNumber = Number(line);
  const suffix = Number.isInteger(lineNumber) && lineNumber > 0 ? `:${lineNumber}` : "";
  const encoded = encodePath(absolutePath);
  if (sshHost) return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${encoded}${suffix}`;
  return `vscode://file${encoded}${suffix}`;
}
