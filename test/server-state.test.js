import assert from "node:assert/strict";
import { on, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { serve } from "../src/server.js";
import { readState, setItem } from "../src/state-store.js";

const ENV = { ...process.env, LAVISH_AXI_HOST: "127.0.0.1", LAVISH_AXI_LINK_HOST: "127.0.0.1", LAVISH_STATE: "" };

async function withServer(env, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-server-state-"));
  const artifact = path.join(dir, "board.html");
  await writeFile(artifact, '<!doctype html><html><body><span data-lavish-ref="pr:x/y#1">?</span></body></html>');
  await setItem(dir, "pr:x/y#1", { status: "open" }, { source: "github" });
  const server = await serve({ env, port: 0, stateFile: path.join(dir, "server.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const { key } = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    }).then((response) => response.json());
    await fn({ dir, base, key });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function sdkSource(base, key) {
  const chromeHtml = await fetch(`${base}/session/${key}`).then((response) => response.text());
  const chrome = JSON.parse(
    chromeHtml.match(/<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/)[1],
  );
  const load = await fetch(`${base}/api/${key}/artifact-loads/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: "state-test",
      request_sequence: chrome.initialArtifactLoadSequence + 1,
      chrome_load_token: chrome.chromeLoadToken,
    }),
  }).then((response) => response.json());
  const query = `key=${key}&artifact_revision=${load.artifact_revision}&artifact_load_token=${encodeURIComponent(load.artifact_load_token)}`;
  return fetch(`${base}/sdk.js?${query}`).then((response) => response.text());
}

/**
 * @param {string} base
 * @param {string} key
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [headers]
 */
function answer(base, key, body, headers = { origin: base }) {
  return fetch(`${base}/api/${key}/state/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("the SDK bundle embeds the directory's store, so first paint is current", async () => {
  await withServer(ENV, async ({ base, key }) => {
    const js = await sdkSource(base, key);
    const options = JSON.parse(js.match(/, (\{"maxAttachmentCount"[\s\S]*\})\);\n\}\)\(\);$/)[1]);
    assert.equal(options.initialState.state.items["pr:x/y#1"].status, "open");
    assert.ok(options.initialState.pageMtimes["board.html"]);
    assert.match(js, /const applyLavishState=/);
  });
});

test("LAVISH_STATE=off embeds nothing and refuses writes", async () => {
  await withServer({ ...ENV, LAVISH_STATE: "off" }, async ({ base, key }) => {
    const js = await sdkSource(base, key);
    assert.match(js, /"initialState":null/);
    const response = await answer(base, key, { id: "q:merge", answer: "yes" });
    assert.equal(response.status, 404);
  });
});

test("a store write is pushed to the open session's live events", async () => {
  await withServer(ENV, async ({ dir, base, key }) => {
    const socket = new WebSocket(`ws://${new URL(base).host}/events/${key}`, { origin: base });
    const messages = on(socket, "message");
    await once(socket, "open");
    const nextState = async () => {
      for (;;) {
        const message = JSON.parse(String((await messages.next()).value[0]));
        if (message.type === "lavish-state") return message.data;
      }
    };
    try {
      assert.equal((await nextState()).state.items["pr:x/y#1"].status, "open", "connect catches up");
      await setItem(dir, "pr:x/y#1", { status: "merged" }, { source: "github" });
      assert.equal((await nextState()).state.items["pr:x/y#1"].status, "merged", "the write is pushed");
    } finally {
      await messages.return();
      socket.close();
    }
  });
});

test("a page may answer a q: item and nothing else", async () => {
  await withServer(ENV, async ({ dir, base, key }) => {
    assert.equal((await answer(base, key, { id: "q:merge", answer: "yes" }, {})).status, 403);
    assert.equal((await answer(base, key, { id: "pr:x/y#1", answer: "merged" })).status, 400);
    const response = await answer(base, key, { id: "q:merge", answer: "yes" });
    assert.equal(response.status, 200);
    const item = (await readState(dir)).items["q:merge"];
    assert.equal(item.status, "answered");
    assert.equal(item.answer, "yes");
    assert.equal(item.source, "board.html");
    assert.ok(Date.parse(item.answeredAt));
    assert.equal((await readState(dir)).items["pr:x/y#1"].status, "open");
  });
});
