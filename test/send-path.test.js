import assert from "node:assert/strict";
import test from "node:test";

import { createOpenOutput } from "../src/cli.js";
import { analyzeSendPath, SEND_PATH_WARNING } from "../src/send-path.js";

function page(script) {
  return `<!doctype html><html><body><button id="go">Go</button><script>${script}</script></body></html>`;
}

test("an artifact that queues prompts and never sends or answers is flagged", () => {
  const result = analyzeSendPath(page(`go.onclick = () => window.lavish.queuePrompt("Ship it");`));
  assert.equal(result.stranded, true);
});

test("a queuePrompt followed by sendQueuedPrompts is not flagged", () => {
  const result = analyzeSendPath(
    page(`go.onclick = () => { window.lavish.queuePrompt("Ship it"); window.lavish.sendQueuedPrompts(); };`),
  );
  assert.equal(result.stranded, false);
});

test("a queuePrompt answered through answerQuestion is not flagged", () => {
  const result = analyzeSendPath(
    page(`go.onclick = () => { lavish.queuePrompt("Plan A"); lavish.answerQuestion("q:plan", "A"); };`),
  );
  assert.equal(result.stranded, false);
});

test("an artifact that never queues a prompt is not flagged", () => {
  assert.equal(analyzeSendPath(page(`console.log("static report");`)).stranded, false);
  assert.equal(analyzeSendPath("").stranded, false);
});

test("sendQueuedPrompts alone does not count as a queuePrompt call", () => {
  assert.equal(analyzeSendPath(page(`lavish.sendQueuedPrompts();`)).stranded, false);
});

test("calls named only in comments or prose do not count either way", () => {
  assert.equal(
    analyzeSendPath(page(`// lavish.queuePrompt("x") was removed\nconsole.log(1);`)).stranded,
    false,
    "a commented-out queue is not a queue",
  );
  assert.equal(
    analyzeSendPath(page(`lavish.queuePrompt("x"); /* lavish.sendQueuedPrompts() later */`)).stranded,
    true,
    "a commented-out send is not a send",
  );
});

test("the open output carries the warning and puts the fix first in next_step", () => {
  const output = createOpenOutput({
    file: "/tmp/a.html",
    url: "http://127.0.0.1:1/session/k",
    status: "opened",
    sendPathWarning: SEND_PATH_WARNING,
  });
  assert.equal(output.send_path_warning, SEND_PATH_WARNING);
  assert.match(output.next_step, /send_path_warning/);
  const clean = createOpenOutput({ file: "/tmp/a.html", url: "http://127.0.0.1:1/session/k", status: "opened" });
  assert.equal("send_path_warning" in clean, false);
});
