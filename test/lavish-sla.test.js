import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ACK_MARK, Sla, answerOf, answeredAfter, quote, readConfig } from "../scripts/lavish-sla.js";

const user = (prompt_id, at, done_at) => ({ role: "user", kind: "annotation", text: "", prompt_id, at, done_at });
const agent = (text, at, done_ids) => ({ role: "agent", text, at, ...(done_ids ? { done_ids } : {}) });

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";

test("a plain reply that ticked several notes answers none of them", () => {
  const a = user("p-one", T0, T1);
  const b = user("p-two", T0, T1);
  const s = { chat: [a, b, agent("blanket", T1)] };
  for (const c of [a, b]) assert.deepEqual(answeredAfter(s, c), { acked: false, answered: false, untrusted: true });
});

test("a plain reply that ticked one note alone answers it", () => {
  const a = user("p-one", T0, T1);
  assert.equal(answeredAfter({ chat: [a, agent("ok", T1)] }, a).answered, true);
});

// The two-note case: a later `--done p-one` lists it in done_ids and keeps every stamp, so p-two
// still shares the plain stamp and stays open.
test("--done listing one note answers it and leaves the other plain-ticked note open", () => {
  const a = user("p-one", T0, T1);
  const b = user("p-two", T0, T1);
  const s = { chat: [a, b, agent("blanket", T1), agent("answer one", T2, ["p-one"])] };
  assert.deepEqual(answeredAfter(s, a), { acked: false, answered: true, untrusted: false });
  assert.deepEqual(answeredAfter(s, b), { acked: false, answered: false, untrusted: true });
});

test("a later reply whose text carries the prompt id answers it; one about another prompt does not", () => {
  const a = user("a1", T0);
  assert.equal(answeredAfter({ chat: [a, agent("a1: done", T1)] }, a).answered, true);
  assert.equal(answeredAfter({ chat: [a, agent("b9: done", T1)] }, a).answered, false);
});

test("the daemon's own ack is received, never an answer, even when its time equals done_at", () => {
  const a = user("a", T0, T1);
  const r = answeredAfter({ chat: [a, agent(`${ACK_MARK} 06:00 · routed to captain`, T1)] }, a);
  assert.deepEqual(r, { acked: true, answered: false, untrusted: false });
});

test("a done_at whose stamping reply the transcript bound evicted counts as answered", () => {
  const a = user("a", T0, T1);
  assert.equal(answeredAfter({ chat: [a] }, a).answered, true);
});

test("answerOf reads the Context data JSON first, then '<qid>: <answer>'", () => {
  assert.deepEqual(answerOf('ANSWER pick\nContext data: {"question":"q-7","answer":"yes"}'), {
    qid: "q-7",
    answer: "yes",
  });
  assert.deepEqual(answerOf("ANSWER (behaviour) q-8: fail closed"), { qid: "q-8", answer: "fail closed" });
  assert.deepEqual(answerOf("just a note"), { qid: null, answer: null });
});

test("quote matches the established spool form", () => {
  assert.equal(quote(""), "''");
  assert.equal(quote("a\nb"), "'a\\nb'");
  assert.equal(quote("it's"), '"it\'s"');
  assert.equal(quote(`it's "x"`), `'it\\'s "x"'`);
});

function fixture(t, env = {}, help = "--agent-reply --done --ended-ok") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lavish-sla-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const page = path.join(dir, "lorem.html");
  writeFileSync(page, "<p>lorem</p>");
  const replies = path.join(dir, "replies.log");
  const fake = path.join(dir, "fake-lavish.js");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log(${JSON.stringify(help)}); process.exit(0); }
fs.appendFileSync(${JSON.stringify(replies)}, JSON.stringify(args) + "\\n");
`,
  );
  chmodSync(fake, 0o755);
  writeFileSync(path.join(dir, "package.json"), '{"type":"commonjs"}');
  const config = readConfig({
    HOME: dir,
    LAVISH_STATE: path.join(dir, "state.json"),
    LAVISH_URL: "http://127.0.0.1:9",
    LAVISH_AXI: fake,
    SLA_STATE: path.join(dir, "sla.json"),
    SLA_LOG: path.join(dir, "sla.log"),
    CAPTAIN_PUSH_SPOOL: path.join(dir, "spool.jsonl"),
    MAC_WORKER_QUEUE: path.join(dir, "queue.jsonl"),
    LAVISH_PROTECTED_FILE: path.join(dir, "protected.json"),
    WATCH_FILE: path.join(dir, "absent-watch.json"),
    OWNERS_FILE: path.join(dir, "absent-owners.json"),
    SLA_SEC: "0",
    REMIND_SEC: "0",
    ACK_AFTER_SEC: "99999",
    ...env,
  });
  const session = { key: "k1", file: page, status: "open", updated_at: new Date().toISOString(), chat: [] };
  const writeState = () => writeFileSync(config.state, JSON.stringify({ sessions: { k1: session } }));
  writeState();
  const lines = (file) => {
    try {
      return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const rows = (file) => lines(file).map((line) => JSON.parse(line));
  return { config, session, writeState, spool: () => rows(config.spool), replies: () => rows(replies), page };
}

test("a tick baselines first, then alarms and reminds once per unanswered note, across restarts", async (t) => {
  const f = fixture(t);
  f.session.chat.push(user("old", T0));
  f.writeState();
  await new Sla(f.config).tick();
  assert.deepEqual(f.spool(), []);

  const at = new Date(Date.now() - 1000).toISOString();
  f.session.chat.push({ ...user("n1", at), text: "lorem question" }, { ...user("n2", at), text: "" });
  f.session.chat.push(agent("n2: answered", new Date().toISOString()));
  f.writeState();
  await new Sla(f.config).tick();
  await new Sla(f.config).tick();
  const rows = f.spool();
  assert.deepEqual(
    rows.map((r) => r.id),
    ["lavish-sla:k1|n1", "lavish-sla:k1|n1:remind"],
  );
  assert.match(rows[0].text, /^NAVID UNREPLIED 0m · lorem\.html · \d\d:\d\d Dhaka · 'lorem question' · owner captain$/);
  assert.match(rows[1].text, /^NAVID STILL UNREPLIED /);
  assert.equal(rows[0].tier, 0);
});

// A reply without --done closes no note, so the ack is a plain reply; any --done id would either close
// a note or, for an id no note has, be refused with UNKNOWN_DONE_ID and leave Navid unacked.
test("the ack is a plain reply that closes no note, and is posted once", async (t) => {
  const f = fixture(t, { ACK_AFTER_SEC: "0", SLA_SEC: "99999" }, "--agent-reply --done --ended-ok");
  await new Sla(f.config).tick();
  f.session.chat.push(user("n1", new Date(Date.now() - 1000).toISOString()));
  f.writeState();
  const sla = new Sla(f.config);
  await sla.tick();
  await sla.tick();
  const replies = f.replies();
  assert.equal(replies.length, 1);
  const [args] = replies;
  assert.equal(args[0], "reply");
  assert.equal(args[1], f.page);
  assert.match(args[3], /^📥 received \d\d:\d\d · routed to captain$/);
  assert.deepEqual(args.slice(4), []);
});

test("on a page Navid ended, only messages sent well before the end skip the alarm", async (t) => {
  const f = fixture(t);
  await new Sla(f.config).tick();
  const end = Date.now() - 1000;
  f.session.chat.push(user("early", new Date(end - 120_000).toISOString()));
  f.session.chat.push(user("withEnd", new Date(end - 10_000).toISOString()));
  Object.assign(f.session, { status: "ended", ended_by: "user", updated_at: new Date(end).toISOString() });
  f.writeState();
  await new Sla(f.config).tick();
  assert.deepEqual(
    f.spool().map((r) => r.id),
    ["lavish-sla:k1|withEnd", "lavish-sla:k1|withEnd:remind"],
  );
});

test("a watched page past the grace with no listener is added to the one watcher; one with a listener is not", async (t) => {
  const feed = path.join(os.tmpdir(), "lavish-sla-feed");
  const f = fixture(t, { POLL_GRACE_SEC: "0", LAVISH_FEED_DIR: feed });
  const sla = new Sla(f.config);
  const watched = new Map([["k1", f.session]]);
  sla.polls([f.session], watched, new Set(["k1"]));
  sla.polls([f.session], watched, new Set());
  for (let i = 0; i < 100 && f.replies().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(f.replies(), [
    ["watch", "--feed-dir", feed, "--owner", "lavish-sla", "--add", f.page, "--name", "lorem"],
  ]);
});
