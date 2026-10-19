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

test("a queuePrompt call shown as page text is not a queue", () => {
  const pre = `<!doctype html><html><body><pre>window.lavish.queuePrompt("example")</pre></body></html>`;
  assert.equal(analyzeSendPath(pre).stranded, false, "a <pre> sample is page text");
  const prose = `<!doctype html><html><body><p>Call <code>lavish.queuePrompt()</code> to queue.</p></body></html>`;
  assert.equal(analyzeSendPath(prose).stranded, false, "prose and <code> are page text");
  const inert = `<!doctype html><html><body><script type="text/plain">lavish.queuePrompt("x")</script></body></html>`;
  assert.equal(analyzeSendPath(inert).stranded, false, "a non-JavaScript script block never runs");
});

test("a send shown only as page text does not count as a send", () => {
  const html = page(`go.onclick = () => window.lavish.queuePrompt("Ship it");`).replace(
    "</body>",
    "<pre>lavish.sendQueuedPrompts()</pre></body>",
  );
  assert.equal(analyzeSendPath(html).stranded, true);
});

test("a queuePrompt in an inline event handler attribute is a queue", () => {
  const html = `<!doctype html><html><body><button onclick="window.lavish.queuePrompt('Ship it')">Go</button></body></html>`;
  assert.equal(analyzeSendPath(html).stranded, true);
  const sent = `<!doctype html><html><body><button onclick="lavish.queuePrompt('A'); lavish.sendQueuedPrompts()">Go</button></body></html>`;
  assert.equal(analyzeSendPath(sent).stranded, false);
});

test("handler-looking text outside a start tag is page text", () => {
  const text = `<!doctype html><html><body><pre> onclick="lavish.queuePrompt(&quot;example&quot;)"</pre></body></html>`;
  assert.equal(analyzeSendPath(text).stranded, false, "handler text inside <pre> is not a handler");
  const hidden = page(`go.onclick = () => window.lavish.queuePrompt("Ship it");`).replace(
    "</body>",
    `<p> onclick="lavish.sendQueuedPrompts()"</p></body>`,
  );
  assert.equal(analyzeSendPath(hidden).stranded, true, "a send shown as text does not hide a real queue");
});

test("handler-looking text inside another attribute's value is not a handler", () => {
  const queued = `<!doctype html><html><body><p title=' onclick="lavish.queuePrompt()"'>Example</p></body></html>`;
  assert.equal(analyzeSendPath(queued).stranded, false);
  const hidden = page(`go.onclick = () => window.lavish.queuePrompt("Ship it");`).replace(
    "</body>",
    `<p title=' onclick="lavish.sendQueuedPrompts()"'>Example</p></body>`,
  );
  assert.equal(analyzeSendPath(hidden).stranded, true);
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
