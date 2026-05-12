import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("marketing demo shows a technical design review workflow", async () => {
  const html = await readFile(new URL("../lavish-editor-marketing/index.html", import.meta.url), "utf8");

  assert.match(html, /technical plan/i);
  assert.match(html, /architecture diagram/i);
  assert.match(html, /WebSocket/i);
  assert.match(html, /SQLite/i);
  assert.match(html, /surface failure modes/i);
  assert.match(html, /Ask the agent for an artifact/);
  assert.match(html, /Then review and collaborate on it in the browser/);

  assert.doesNotMatch(html, /Mock user research report/);
  assert.doesNotMatch(html, /technical design plan/i);
  assert.doesNotMatch(html, /as an html artifact/i);
  assert.doesNotMatch(html, /use pie chart/);
  assert.doesNotMatch(html, /also change to dark mode/);
  assert.doesNotMatch(html, /keep long-poll/i);
  assert.doesNotMatch(html, /local state file/i);
});
