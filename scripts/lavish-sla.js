#!/usr/bin/env node
// lavish-sla: every Navid prompt on a watched Lavish page is polled, acked, routed and, if nobody
// answers, escalated once. Runs on the host that serves Lavish, systemd user unit lavish-sla. Node
// built-ins only, so the file runs copied anywhere without an install.
//
// Every TICK (10 s), against ~/.lavish-axi/state.json and GET /health on the local server:
//
//   1. Watch set. Open sessions (status != ended) whose file exists and which were updated within
//      WATCH_DAYS, plus every file named in WATCH_FILE {"files": [...]}. The set is written to
//      PROTECTED_FILE ({"files", "updated_at"}), which the lavish-axi fork reads to refuse an agent
//      `lavish-axi end` on a watched page.
//   2. Exactly one poll. A watched page with no listener for POLL_GRACE is added to the host's one
//      `lavish-axi watch` process: `lavish-axi watch --feed-dir <LAVISH_FEED_DIR> --add <file> --name
//      <log name>` (the page stem, or "<dir>-index" for a non-hub index.html, so two index.html pages
//      never share a feed log). The watcher drops a page once its session ends; a `lavish-axi poll`
//      still running against an ENDED session is killed: an ended session is never re-armed.
//   3. Ack (received). A Navid entry (role user, not layout-warnings) newer than the first run, not yet
//      answered, gets ONE reply after ACK_AFTER: `📥 received HH:MM · routed to <owner>` (Dhaka time).
//      The ack never ticks the note and never counts as an answer: it is a plain `lavish-axi reply`
//      with no --done, which `reply --help` documents as closing no note (any --done id would close
//      that note, and one no note has is refused with UNKNOWN_DONE_ID). With `reply --ended-ok` a
//      Send & End message on an ended page is acked too, without reopening it. That flag is probed
//      once per process (restart after an upgrade).
//      An "ANSWER <...> <qid>: <answer>" prompt also sets shared state q:<qid> status=answered in the
//      page's directory, so every page binding that question disables it and shows the pick, and the
//      ack reads `✅ YOUR PICK <qid>: <answer> · routed to <owner>`.
//   4. Route. The owner comes from OWNERS_FILE ({"pages": {basename|session key: worker},
//      "qid_prefix": {prefix: worker}}); default "captain". The captain already gets the NAVID row
//      from navid-inbox; for any other owner a steer row is appended to the Mac worker queue
//      (MAC_WORKER_QUEUE, run on the Mac as `captain steer`). The steer names the prompt id and the
//      exact answer command: `lavish-axi reply <page> --done <prompt_id> --agent-reply "<prompt_id>: <one line>"`.
//   5. Answered, per prompt id: see answeredAfter. Received (`acked`) and answered are separate ids in
//      STATE_FILE. An answer cached from a reply that did not name the prompt is reopened while the
//      prompt is younger than SLA_SEC; an older one stays answered, so a deploy fires no alarm burst.
//   6. SLA alarm. An entry still unanswered after SLA_SEC (600) pushes ONE tier-0 line to the captain
//      spool: `NAVID UNREPLIED 10m · <page> · <HH:MM Dhaka> · '<text>' · owner <w>`, and if still
//      unanswered REMIND_SEC (1800) later, ONE reminder `NAVID STILL UNREPLIED <n>m · ...`. Alarmed and
//      reminded ids persist in STATE_FILE, so no repeat across restarts. On a page Navid ended himself
//      (status ended, ended_by user) a message sent with the end (same submit, or within SEND_END_SEC
//      (60) before it) is a real ask and alarms as usual; only messages sent earlier skip the alarm and
//      reminder. lavish-axi stores no end time, so the end time is recorded in STATE_FILE.ended when the
//      page is first seen ended: the session's updated_at, unless that is the `at` of an agent reply
//      (then the end time is unknown and every unanswered message alarms).
//
// Ids: "<session key>|<prompt_id or at>". Every decision is persisted in STATE_FILE before the next
// step, so a restart neither re-acks, re-routes nor re-alarms. The first run baselines existing
// entries. Test pages (negctl-*, relaytest-*) are skipped unless ALLOW_TEST_PAGES=1; SLA_PAGE_PREFIX
// limits the pages handled. --once runs a single tick.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ACK_MARK = "📥 received";
export const PICK_MARK = "✅ YOUR PICK";
const TEST_PAGE = /^(negctl|relaytest)-|^test\.html$|^rt\d+\.html$|^cutover-rt\.html$/;
const ANSWER = /^ANSWER\b([\s\S]*?)(?:\n|$)/;
const DHAKA_MS = 6 * 3600 * 1000;

/** @param {NodeJS.ProcessEnv} env */
export function readConfig(env = process.env) {
  const home = env.HOME || os.homedir();
  const ceo = `${home}/orca/projects/ceo/.tmp`;
  const num = (name, fallback) => {
    const value = Number(env[name]);
    return env[name] !== undefined && env[name] !== "" && Number.isFinite(value) ? value : fallback;
  };
  return {
    state: env.LAVISH_STATE || `${home}/.lavish-axi/state.json`,
    url: env.LAVISH_URL || "http://127.0.0.1:4387",
    lavish: env.LAVISH_AXI || `${home}/.local/node/bin/lavish-axi`,
    feedDir: env.LAVISH_FEED_DIR || `${home}/.lavish-axi/feed`,
    stateFile: env.SLA_STATE || `${home}/.omp/agent/state/lavish-sla.json`,
    log: env.SLA_LOG || `${home}/.omp/agent/state/lavish-sla.log`,
    watchFile: env.WATCH_FILE || `${ceo}/system/lavish-watch.json`,
    ownersFile: env.OWNERS_FILE || `${ceo}/system/lavish-owners.json`,
    protectedFile: env.LAVISH_PROTECTED_FILE || `${home}/.lavish-axi/protected-pages.json`,
    spool: env.CAPTAIN_PUSH_SPOOL || `${home}/.omp/agent/state/captain-push.jsonl`,
    macQueue: env.MAC_WORKER_QUEUE || `${home}/.omp/agent/state/mac-worker-queue.jsonl`,
    hub: env.CAPTAIN_HUB || `${ceo}/inbox/index.html`,
    inbox: `${ceo}/inbox`,
    tickSec: num("TICK_SEC", 10),
    ackAfterSec: num("ACK_AFTER_SEC", 60),
    slaSec: num("SLA_SEC", 600),
    remindSec: num("REMIND_SEC", 1800),
    sendEndSec: num("SEND_END_SEC", 60),
    pollGraceSec: num("POLL_GRACE_SEC", 20),
    watchDays: num("WATCH_DAYS", 3),
    prefix: env.SLA_PAGE_PREFIX || "",
    allowTest: env.ALLOW_TEST_PAGES === "1",
  };
}

const ms = (ts) => Date.parse(String(ts));
const utcSeconds = (date) => `${date.toISOString().slice(0, 19)}Z`;

export function dhaka(ts) {
  return new Date(ms(ts) + DHAKA_MS).toISOString().slice(11, 16);
}

// Code-point slice, so an emoji or other astral character is never cut in half.
const head = (text, n) =>
  Array.from(String(text ?? ""))
    .slice(0, n)
    .join("");

// Quotes a string the way the spool and steer rows have always shown it: single quotes, or double
// quotes when the text holds a single quote and no double quote.
export function quote(text) {
  const s = String(text ?? "");
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .split(q)
    .join(`\\${q}`);
  return `${q}${body}${q}`;
}

const sleepSync = (millis) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, millis);

// A JSON file, or `fallback` when it does not exist. A torn read while another process rewrites the
// file is retried for up to two seconds before `fallback` is returned.
export function load(file, fallback) {
  for (let i = 0; i < 20; i++) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return fallback;
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch {
      sleepSync(100);
    }
  }
  return fallback;
}

function save(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

const append = (file, row) => appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o644 });

export function entryId(s, c) {
  return `${s.key}|${c.prompt_id || c.at}`;
}

function* userEntries(s) {
  for (const c of s.chat || []) if (c?.role === "user" && c.kind !== "layout-warnings" && c.at) yield c;
}

const isAck = (x) => {
  const t = x.text || "";
  return t.startsWith(ACK_MARK) || t.startsWith(PICK_MARK);
};

/**
 * Whether one Navid entry was acked and answered. acked: a later ack/pick line of this daemon.
 * answered: a non-ack agent entry that names this prompt - a later one whose text carries the prompt
 * id or whose `done_ids` lists it (lavish-axi lists there every note a `reply --done a,b,c` answered,
 * including one a plain reply ticked before) - or the one whose `at` equals the note's done_at when that
 * stamp was by id (`reply --done <id>`). A plain `reply` ticks every delivered open note with one time,
 * so a done_at shared by several notes counts only when a reply names this prompt; otherwise untrusted
 * is true and the prompt stays open. A done_at whose stamping reply is no longer in the transcript (the
 * transcript bound evicted it) counts as answered.
 */
export function answeredAfter(s, c) {
  const pid = c.prompt_id;
  const done = c.done_at;
  const chat = s.chat || [];
  let acked = false;
  let answered = false;
  let stampedByAck = false;
  let untrusted = false;
  const shared = done != null && chat.filter((y) => y?.role === "user" && y.done_at === done).length > 1;
  for (const x of chat) {
    if (x?.role !== "agent") continue;
    const at = x.at || "";
    const named = Boolean(pid) && ((x.text || "").includes(pid) || (x.done_ids || []).includes(pid));
    if (isAck(x)) {
      acked ||= at > c.at;
      stampedByAck ||= done != null && at === done;
    } else if (named && at > c.at) {
      answered = true;
    } else if (done && at === done) {
      if (shared && !(x.done_ids || []).includes(pid)) untrusted = true;
      else answered = true;
    }
  }
  if (done && !answered && !stampedByAck && !chat.some((x) => x?.at === done)) answered = true;
  return { acked, answered, untrusted: untrusted && !answered };
}

/** The question id and answer of an ANSWER prompt: its Context data JSON wins, else '<qid>: <answer>'. */
export function answerOf(text) {
  const m = ANSWER.exec(text || "");
  if (!m) return { qid: null, answer: null };
  const ctx = /Context data:\s*(\{[\s\S]*\})/.exec(text);
  if (ctx) {
    try {
      const d = JSON.parse(ctx[1]);
      if (d?.question) return { qid: String(d.question), answer: String(d.answer ?? "") };
    } catch {
      // not JSON: fall through to the '<qid>: <answer>' form
    }
  }
  const line = m[1].trim();
  const colon = line.indexOf(":");
  const q = colon < 0 ? line : line.slice(0, colon);
  const words = q.split(/\s+/).filter(Boolean);
  return { qid: words.length ? words.at(-1) : null, answer: colon < 0 ? "" : line.slice(colon + 1).trim() };
}

export class Sla {
  /** @param {ReturnType<typeof readConfig>} config */
  constructor(config) {
    this.c = config;
    this.st = load(config.stateFile, null);
    this.sessions = [];
    // session key -> monotonic ms first seen without a listener
    this.noListener = new Map();
    /** @type {Set<string> | null} */
    this.flagSet = null;
  }

  log(message) {
    appendFileSync(this.c.log, `${utcSeconds(new Date())} ${message}\n`);
  }

  wanted(page) {
    return page.startsWith(this.c.prefix) && (this.c.allowTest || !TEST_PAGE.test(page));
  }

  loopName(file) {
    const stem = path.parse(file).name;
    if (stem === "index" && path.resolve(file) !== path.resolve(this.c.hub))
      return `${path.basename(path.dirname(file))}-index`;
    return stem;
  }

  // One tier-0 captain spool row.
  push(id, text) {
    const summary = head(text, 200);
    append(this.c.spool, {
      id,
      ts: new Date().toISOString(),
      worker: "lavish-sla",
      tier: 0,
      kind: "lavish",
      status: "progress",
      summary,
      question: { id, text: summary },
      text,
    });
  }

  baseline(sessions) {
    const ids = sessions.flatMap((s) => [...userEntries(s)].map((c) => entryId(s, c))).sort();
    this.st = {
      baseline_at: new Date().toISOString(),
      baseline: ids,
      acked: {},
      answered: {},
      alarmed: {},
      reminded: {},
      routed: {},
    };
    save(this.c.stateFile, this.st);
    this.log(`baseline: ${ids.length} existing entries`);
  }

  watchSet(sessions) {
    const extra = new Set(load(this.c.watchFile, {})?.files || []);
    const horizon = Date.now() - this.c.watchDays * 86400 * 1000;
    const watched = new Map();
    for (const s of sessions) {
      const f = s.file || "";
      if (s.status === "ended" || !existsSync(f) || !this.wanted(path.basename(f))) continue;
      if (extra.has(f) || (s.updated_at && ms(s.updated_at) >= horizon)) watched.set(s.key, s);
    }
    const files = [
      ...new Set([...[...watched.values()].map((s) => s.file), ...[...extra].filter((f) => existsSync(f))]),
    ].sort();
    if (JSON.stringify(load(this.c.protectedFile, {})?.files) !== JSON.stringify(files))
      save(this.c.protectedFile, { files, updated_at: utcSeconds(new Date()) });
    return watched;
  }

  // pid and args of every `lavish-axi poll` process.
  *procs() {
    const out = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).stdout || "";
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      const space = trimmed.indexOf(" ");
      if (space < 0) continue;
      const args = trimmed.slice(space + 1);
      if (args.includes(" poll ")) yield { pid: Number(trimmed.slice(0, space)), args };
    }
  }

  polls(sessions, watched, listeners) {
    const mono = performance.now();
    for (const [k, s] of watched) {
      if (listeners.has(k)) {
        this.noListener.delete(k);
        continue;
      }
      if (!this.noListener.has(k)) this.noListener.set(k, mono);
      if (mono - this.noListener.get(k) >= this.c.pollGraceSec * 1000) {
        const add = ["watch", "--feed-dir", this.c.feedDir, "--owner", "lavish-sla", "--add", s.file];
        spawn(this.c.lavish, [...add, "--name", this.loopName(s.file)], { stdio: "ignore", detached: true }).unref();
        this.log(`watch added: ${s.file} (${k})`);
        this.noListener.set(k, mono); // the next attempt waits another grace period
      }
    }
    const watchedFiles = new Set([...watched.values()].map((s) => s.file));
    const ended = new Set(sessions.filter((s) => s.status === "ended" && !watchedFiles.has(s.file)).map((s) => s.file));
    for (const { pid, args } of this.procs()) {
      const words = args.split(" --owner")[0].split(/\s+/).filter(Boolean);
      let target = words.at(-1) || "";
      // a poll started with a relative path names a page in the hub's directory
      if (target && !target.startsWith("/")) target = path.join(this.c.inbox, target);
      if (ended.has(target)) {
        try {
          process.kill(pid, "SIGTERM");
          this.log(`killed poll on ended session: pid ${pid} ${args.slice(0, 160)}`);
        } catch {
          // already gone
        }
      }
    }
  }

  owner(s, qid) {
    const o = load(this.c.ownersFile, {}) || {};
    for (const [prefix, w] of Object.entries(o.qid_prefix || {})) if (qid && qid.startsWith(prefix)) return w;
    const pages = o.pages || {};
    return pages[s.key] || pages[path.basename(s.file)] || "captain";
  }

  // Which optional `lavish-axi reply` flags this install knows: --ended-ok.
  flags() {
    if (!this.flagSet) {
      const h = spawnSync(this.c.lavish, ["reply", "--help"], { encoding: "utf8", timeout: 30_000 });
      const out = `${h.stdout || ""}${h.stderr || ""}`;
      this.flagSet = new Set(["--ended-ok"].filter((f) => out.includes(f)));
    }
    return this.flagSet;
  }

  // Posts the ack as a plain reply, which closes no note. `--ended-ok` answers a Send & End message
  // on an ended page without reopening it.
  reply(file, text, ended) {
    const cmd = ["reply", file, "--agent-reply", text];
    if (ended) cmd.push("--ended-ok");
    const r = spawnSync(this.c.lavish, cmd, { encoding: "utf8", timeout: 30_000 });
    return { rc: r.status ?? 1, out: `${r.stdout || ""}${r.stderr || ""}`.trim().slice(-200) };
  }

  // When Navid ended this page, in ms, or null (not ended by him, or the time is unknown). Recorded
  // once, at first sight, and dropped if the page is reopened.
  endedAt(s, t) {
    const st = this.st;
    const key = s.key;
    if (s.status !== "ended" || s.ended_by !== "user") {
      if (key in st.ended) {
        delete st.ended[key];
        save(this.c.stateFile, st);
      }
      return null;
    }
    if (!(key in st.ended)) {
      const ua = s.updated_at;
      const byReply = (s.chat || []).some((x) => x?.role === "agent" && x.at === ua);
      st.ended[key] = { at: byReply || !ua ? null : ua, seen: t.toISOString() };
      save(this.c.stateFile, st);
      this.log(`ended by user ${key} at ${st.ended[key].at}`);
    }
    const at = st.ended[key].at;
    return at ? ms(at) : null;
  }

  handle(watched) {
    const st = this.st;
    const c = this.c;
    const t = new Date();
    for (const k of ["answered", "reminded", "ended"]) st[k] ??= {};
    const base = new Set(st.baseline);
    for (const s of this.sessions) {
      // ended pages too: a Send & End message is routed, acked and alarmed
      if (!this.wanted(path.basename(s.file || ""))) continue;
      const endedAt = this.endedAt(s, t);
      const live = watched.has(s.key);
      for (const e of userEntries(s)) {
        const eid = entryId(s, e);
        if (base.has(eid)) continue;
        const age = (t.getTime() - ms(e.at)) / 1000;
        let { acked, answered, untrusted } = answeredAfter(s, e);
        if (eid in st.answered && untrusted && age < c.slaSec) {
          delete st.answered[eid];
          save(c.stateFile, st);
          this.log(`reopened ${eid}: done_at stamped by a reply that did not name it`);
        }
        if (eid in st.answered) answered = true;
        else if (answered) {
          st.answered[eid] = t.toISOString();
          save(c.stateFile, st);
          this.log(`answered ${eid}`);
        }
        const { qid, answer } = answerOf(e.text || "");
        const owner = this.owner(s, qid);
        const page = path.basename(s.file);
        if (!(eid in st.routed)) {
          if (owner !== "captain") {
            const pid = e.prompt_id;
            const how = pid
              ? `prompt id ${pid}. Handle it, then answer him on the page with exactly this command, which closes only ` +
                `this prompt: lavish-axi reply ${s.file} --done ${pid} --agent-reply "${pid}: <one line>".`
              : `Handle it, then answer him on the page: lavish-axi reply ${s.file} --agent-reply "<one line>".`;
            append(c.macQueue, {
              id: randomUUID().replace(/-/g, "").slice(0, 12),
              worker: owner,
              mode: "steer",
              msg: `Navid on Lavish page ${page} at ${dhaka(e.at)} Dhaka: ${quote(head(e.text, 1500))}, ${how}`,
              at: utcSeconds(t),
            });
          }
          st.routed[eid] = { owner, at: t.toISOString() };
          save(c.stateFile, st);
          this.log(`routed ${eid} -> ${owner}`);
        }
        const canAck = live || (s.status === "ended" && this.flags().has("--ended-ok"));
        if (canAck && !(eid in st.acked) && !acked && !answered && age >= c.ackAfterSec) {
          let text;
          if (qid) {
            spawnSync(
              c.lavish,
              [
                "state",
                "set",
                `q:${qid}`,
                "status=answered",
                `answer=${head(answer, 400)}`,
                `answeredAt=${e.at}`,
                "--source",
                "navid",
                "--dir",
                path.dirname(s.file),
              ],
              { timeout: 30_000 },
            );
            text = `${PICK_MARK} ${qid}: ${head(answer, 120)} · routed to ${owner}`;
          } else text = `${ACK_MARK} ${dhaka(e.at)} · routed to ${owner}`;
          const { rc, out } = this.reply(s.file, text, !live);
          st.acked[eid] = { at: t.toISOString(), rc };
          save(c.stateFile, st);
          this.log(`ack ${eid} rc=${rc} ${quote(text)} ${rc ? out : ""}`);
        }
        const quiet = endedAt !== null && ms(e.at) < endedAt - c.sendEndSec * 1000;
        const line = `${Math.floor(age / 60)}m · ${page} · ${dhaka(e.at)} Dhaka · ${quote(head(e.text, 200))} · owner ${owner}`;
        if (!(eid in st.alarmed) && !answered && !quiet && age >= c.slaSec) {
          this.push(`lavish-sla:${eid}`, `NAVID UNREPLIED ${line}`);
          st.alarmed[eid] = t.toISOString();
          save(c.stateFile, st);
          this.log(`alarm ${eid}`);
        }
        if (eid in st.alarmed && !(eid in st.reminded) && !answered && !quiet && age >= c.slaSec + c.remindSec) {
          this.push(`lavish-sla:${eid}:remind`, `NAVID STILL UNREPLIED ${line}`);
          st.reminded[eid] = t.toISOString();
          save(c.stateFile, st);
          this.log(`reminder ${eid}`);
        }
      }
    }
  }

  async tick() {
    const state = load(this.c.state, null);
    if (state === null) return;
    const sessions = Object.values(state.sessions || {});
    if (this.st === null) this.baseline(sessions);
    let listeners = null;
    try {
      const r = await fetch(`${this.c.url}/health`, { signal: AbortSignal.timeout(5000) });
      const body = await r.json();
      listeners = new Set((body.listeners || []).map((l) => l?.key));
    } catch (error) {
      this.log(`server unreachable: ${/** @type {Error} */ (error).message}`);
    }
    const watched = this.watchSet(sessions);
    this.sessions = sessions;
    if (listeners !== null) this.polls(sessions, watched, listeners);
    this.handle(watched);
  }
}

export async function main(argv = process.argv, env = process.env) {
  const config = readConfig(env);
  const sla = new Sla(config);
  sla.log(`start pid=${process.pid} prefix=${quote(config.prefix)} ack=${config.ackAfterSec}s sla=${config.slaSec}s`);
  for (;;) {
    try {
      await sla.tick();
    } catch (error) {
      // the loop stays alive; one bad tick is logged and the next one runs
      sla.log(`tick error: ${/** @type {Error} */ (error)?.stack || error}`);
    }
    if (argv.includes("--once")) return;
    await new Promise((resolve) => setTimeout(resolve, config.tickSec * 1000));
  }
}

// npm links the `lavish-sla` bin as a symlink, so argv[1] is compared after resolving it.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
