import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";
export const IPV6_LOOPBACK_HOST = "::1";

export function isWildcardHost(host) {
  const value = String(host || "")
    .trim()
    .toLowerCase();
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const family = isIP(unbracketed);
  if (family === 4) return unbracketed === "0.0.0.0";
  if (family !== 6) return false;
  try {
    const normalized = new URL(`http://[${unbracketed}]/`).hostname.slice(1, -1);
    return normalized === "::" || normalized === "::ffff:0:0";
  } catch {
    return false;
  }
}

// Address the server binds to (LAVISH_AXI_HOST). Defaults to loopback. A wildcard value
// (0.0.0.0 or ::) is never listened on; resolveListenHosts maps it to loopback.
export function bindHost(env = process.env) {
  return env.LAVISH_AXI_HOST?.trim() || LOOPBACK_HOST;
}

/**
 * Concrete listen addresses. Never includes 0.0.0.0 / ::.
 * The first entry is the primary (requested) host. Loopback is always included: it is the one
 * address every CLI probes whatever its own LAVISH_AXI_HOST says, so a server pinned to a
 * Tailscale or LAN address is still found by a client configured without one instead of that
 * client spawning a second daemon on the same port. When LAVISH_AXI_HOST is unset, the Tailscale
 * IPv4 is added when present.
 * @param {{ host?: string, env?: NodeJS.ProcessEnv, tailscale?: { ipv4?: string } | null, extraHosts?: string[] }} [options]
 * @returns {string[]}
 */
export function resolveListenHosts({ host, env = process.env, tailscale = null, extraHosts = [] } = {}) {
  const envHost = env.LAVISH_AXI_HOST?.trim() || "";
  const autoTailscale = !envHost;
  const requested = host || bindHost(env);
  const primary = isWildcardHost(requested) ? LOOPBACK_HOST : requested || LOOPBACK_HOST;
  const hosts = [primary, LOOPBACK_HOST];
  if (autoTailscale && tailscale?.ipv4 && tailscale.ipv4 !== primary && !isWildcardHost(tailscale.ipv4)) {
    hosts.push(tailscale.ipv4);
  }
  hosts.push(...extraHosts);
  return sanitizeListenHosts(hosts);
}

/**
 * @param {string[] | undefined} hosts
 * @returns {string[]}
 */
export function sanitizeListenHosts(hosts) {
  const out = [];
  for (const value of hosts || []) {
    const host = String(value || "").trim();
    if (!host || isWildcardHost(host)) continue;
    if (!out.includes(host)) out.push(host);
  }
  return out.length ? out : [LOOPBACK_HOST];
}

/**
 * With `keepUnresolved`, a name that does not resolve right now is kept as the name, so it is bound
 * and retried like any other unavailable address and reported, instead of failing or vanishing. A
 * name that resolves to an all-interfaces address is always refused.
 * @param {string[]} hosts
 * @param {{ lookup?: typeof dnsLookup, keepUnresolved?: boolean }} [options]
 * @returns {Promise<string[]>}
 */
export async function resolveConcreteListenHosts(hosts, { lookup = dnsLookup, keepUnresolved = false } = {}) {
  const resolved = [];
  for (const host of hosts) {
    const addresses = await lookup(host, { all: true, verbatim: true }).catch((error) => {
      if (keepUnresolved) return [];
      throw error;
    });
    if (!Array.isArray(addresses) || addresses.length === 0) {
      if (!keepUnresolved) throw new Error(`Listen host did not resolve: ${host}`);
      if (!resolved.includes(host)) resolved.push(host);
      continue;
    }
    if (addresses.some(({ address }) => isWildcardHost(address))) {
      throw new Error(`Listen host resolves to an all-interfaces address: ${host}`);
    }
    const address = addresses[0]?.address;
    if (!address || !isIP(address)) throw new Error(`Listen host did not resolve to an IP address: ${host}`);
    if (!resolved.includes(address)) resolved.push(address);
  }
  return resolved;
}

/**
 * Hostname written into session URLs. A running Tailscale MagicDNS name is the
 * phone-ready headline host; an explicit link host is used only without MagicDNS.
 * @param {{ env?: NodeJS.ProcessEnv, tailscale?: { magicDnsName?: string | null, ipv4?: string } | null, fallbackHost?: string }} [options]
 */
export function resolveLinkHost({ env = process.env, tailscale = null, fallbackHost = LOOPBACK_HOST } = {}) {
  if (tailscale?.magicDnsName) return tailscale.magicDnsName;
  const explicit = env.LAVISH_AXI_LINK_HOST?.trim();
  if (explicit) return explicit;
  return isWildcardHost(fallbackHost) ? LOOPBACK_HOST : fallbackHost || LOOPBACK_HOST;
}

// Host the CLI uses to reach the server it spawned. A wildcard bind address can't be
// dialed directly, so the local control channel falls back to loopback.
export function clientHost(env = process.env) {
  return resolveListenHosts({ env })[0];
}

// Hostname written into the session URLs the server generates (LAVISH_AXI_LINK_HOST).
// Defaults to the host the CLI dials.
export function linkHost(env = process.env) {
  return env.LAVISH_AXI_LINK_HOST?.trim() || clientHost(env);
}

// Extra Host header values the server's DNS-rebinding guard accepts beyond the
// loopback names and the resolved bind/link host, set via LAVISH_AXI_ALLOWED_HOSTS
// (whitespace-separated). A lone "*" disables the guard entirely - an explicit
// opt-out for operators fronting the server with their own auth/proxy.
export function extraAllowedHosts(env = process.env) {
  return (env.LAVISH_AXI_ALLOWED_HOSTS || "").split(/\s+/).filter(Boolean);
}

// Brackets an IPv6 literal so it can be safely interpolated into a URL authority.
// IPv4 addresses and hostnames pass through unchanged.
export function hostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function stateDir() {
  return process.env.LAVISH_AXI_STATE_DIR || path.join(os.homedir(), ".lavish-axi");
}

export function stateFile() {
  return path.join(stateDir(), "state.json");
}

// Which Lavish installation a server belongs to, reported by /health. A CLI only ever stops a
// duplicate daemon that shares its own state file, so another user's (or another test's) server on
// the same port at a different address is never touched. Resolve the directory, not the state file:
// state.json may not exist yet when the server first reports its identity.
export function stateId(file = stateFile()) {
  const directory = path.dirname(path.resolve(file));
  let canonicalDirectory;
  try {
    canonicalDirectory = realpathSync(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    canonicalDirectory = directory;
  }
  return createHash("sha256")
    .update(path.join(canonicalDirectory, path.basename(file)))
    .digest("hex")
    .slice(0, 16);
}

export function serverLogFile() {
  return path.join(stateDir(), "server.log");
}

export async function ensureStateDir() {
  await mkdir(stateDir(), { recursive: true });
}

// The Host allowlist a server was started with, kept beside state.json so a server a client
// spawns later serves the same names. Only `lavish-axi server` writes it.
export function allowedHostsFile() {
  return path.join(stateDir(), "allowed-hosts.json");
}

// A set LAVISH_AXI_ALLOWED_HOSTS is recorded; one set to blank removes the record; an unset one
// leaves it alone, since a spawned server started without the variable must not erase it.
export async function recordAllowedHosts(env = process.env) {
  const value = env.LAVISH_AXI_ALLOWED_HOSTS;
  if (value === undefined) return;
  const file = allowedHostsFile();
  if (!value.trim()) {
    await rm(file, { force: true });
    return;
  }
  await ensureStateDir();
  const partial = `${file}.${process.pid}.tmp`;
  await writeFile(partial, `${JSON.stringify({ allowed_hosts: value })}\n`, "utf8");
  await rename(partial, file);
}

// The allowlist a spawned server must start with: the caller's own LAVISH_AXI_ALLOWED_HOSTS when
// set, else the recorded one, else undefined (none was ever configured). A record that exists but
// cannot be read or parsed throws: starting without it would serve with no allowlist at all.
export async function allowedHostsForSpawn(env = process.env) {
  if (env.LAVISH_AXI_ALLOWED_HOSTS !== undefined) return env.LAVISH_AXI_ALLOWED_HOSTS;
  const file = allowedHostsFile();
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") return undefined;
    throw new Error(`cannot read the recorded Host allowlist ${file}: ${/** @type {Error} */ (error).message}`, {
      cause: error,
    });
  }
  let value;
  try {
    value = JSON.parse(raw)?.allowed_hosts;
  } catch {
    value = undefined;
  }
  if (typeof value !== "string") throw new Error(`the recorded Host allowlist ${file} is not valid`);
  return value;
}

// A server a CLI spawns carries this in its environment, so it never records itself as the hub.
export const SPAWNED_SERVER_ENV = "LAVISH_AXI_SPAWNED_SERVER";

// The record a `lavish-axi server` started directly (a service manager's hub, not a CLI's spawn)
// keeps beside state.json while it owns the state directory: its pid and port. The hub removes it
// when it exits on its own (`lavish-axi stop`, /shutdown, the idle timeout); a signal leaves it,
// so a hub its service manager restarts keeps its claim on the port in between.
export function managedHubFile() {
  return path.join(stateDir(), "managed-hub.json");
}

/** @param {{ pid: number, port: number }} hub */
export async function recordManagedHub(hub) {
  await ensureStateDir();
  const file = managedHubFile();
  const partial = `${file}.${process.pid}.tmp`;
  await writeFile(partial, `${JSON.stringify({ pid: hub.pid, port: hub.port })}\n`, "utf8");
  await rename(partial, file);
}

// Removes the record only while it still names `pid`, so a hub never deletes its successor's claim.
/** @param {number} pid */
export async function forgetManagedHub(pid) {
  const file = managedHubFile();
  let record;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return;
  }
  if (record?.pid === pid) await rm(file, { force: true });
}

// `lavish-axi stop` is an explicit stop of this state directory's server, so it drops any hub
// record too, including one a hub killed by a signal left behind.
export async function clearManagedHub() {
  await rm(managedHubFile(), { force: true });
}

// True while a CLI must leave `port` to the hub rather than spawn a server: a hub record exists for
// this state directory and names that port, whatever its age or whether its process is alive. A
// record that cannot be parsed still counts, since only a hub writes that file.
/** @param {number} port */
export function managedHubExpected(port) {
  let raw;
  try {
    raw = readFileSync(managedHubFile(), "utf8");
  } catch {
    return false;
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return true;
  }
  return typeof record?.port !== "number" || record.port === port;
}

export function defaultPort() {
  return Number(process.env.LAVISH_AXI_PORT || 4387);
}
