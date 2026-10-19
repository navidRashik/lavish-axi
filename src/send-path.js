// Render-free check for an artifact whose own controls queue feedback and then never deliver it:
// it calls window.lavish.queuePrompt() but neither window.lavish.sendQueuedPrompts() nor
// window.lavish.answerQuestion(). The reviewer clicks the artifact's button, sees nothing go to
// the agent, and the note sits in the queue until they find Send to Agent - or close the tab.
// Like the self-paint check this is a warning only: never block the open, never auto-repair, and
// a page with no queuePrompt call at all is never flagged.

// Only code the page can run counts: inline classic/module <script> bodies and inline on*="..."
// handler attributes. Page text (<pre>, <code>, prose), HTML comments, external <script src>, and
// non-JavaScript script blocks (text/plain, application/json, templates) never queue anything.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_TYPE_RE = /\btype\s*=\s*["']?([^"'\s>]+)/i;
const JS_TYPE_RE = /^(?:module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i;
const START_TAG_RE = /<[a-z][a-z0-9-]*\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
// One attribute per match: its name, then a double-quoted, single-quoted or bare value. Values are
// consumed whole, so handler-looking text inside another attribute's value is never a handler.
const ATTRIBUTE_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
// A `//` right after `:` is a URL scheme ("https://"), not a comment.
const LINE_COMMENT_RE = /(^|[^:\\])\/\/[^\n]*/g;
const QUEUE_CALL_RE = /\bqueuePrompt\s*\(/;
const SEND_CALL_RE = /\b(?:sendQueuedPrompts|answerQuestion)\s*\(/;

export const SEND_PATH_WARNING =
  "This artifact calls window.lavish.queuePrompt() but never window.lavish.sendQueuedPrompts() or window.lavish.answerQuestion(), so feedback its own controls queue does not reach you until the reviewer finds Send to Agent. Call sendQueuedPrompts() after queueing when a control should send right away, or answerQuestion() for a store-bound question.";

function executableCode(html) {
  const markup = html.replace(HTML_COMMENT_RE, "");
  const parts = [];
  for (const [, attrs, body] of markup.matchAll(SCRIPT_RE)) {
    const type = SCRIPT_TYPE_RE.exec(attrs)?.[1];
    if (type && !JS_TYPE_RE.test(type)) continue;
    parts.push(body);
  }
  for (const [, attrs] of markup.replace(SCRIPT_RE, "").matchAll(START_TAG_RE)) {
    for (const [, name, doubleQuoted, singleQuoted, bare] of attrs.matchAll(ATTRIBUTE_RE)) {
      if (/^on[a-z]+$/i.test(name)) parts.push(doubleQuoted ?? singleQuoted ?? bare ?? "");
    }
  }
  return parts.join("\n").replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");
}

/**
 * @param {string} html
 * @returns {{ stranded: boolean }}
 */
export function analyzeSendPath(html) {
  const code = executableCode(typeof html === "string" ? html : "");
  return { stranded: QUEUE_CALL_RE.test(code) && !SEND_CALL_RE.test(code) };
}
