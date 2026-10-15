// Render-free check for an artifact whose own controls queue feedback and then never deliver it:
// it calls window.lavish.queuePrompt() but neither window.lavish.sendQueuedPrompts() nor
// window.lavish.answerQuestion(). The reviewer clicks the artifact's button, sees nothing go to
// the agent, and the note sits in the queue until they find Send to Agent - or close the tab.
// Like the self-paint check this is a warning only: never block the open, never auto-repair, and
// a page with no queuePrompt call at all is never flagged.

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
// A `//` right after `:` is a URL scheme ("https://"), not a comment.
const LINE_COMMENT_RE = /(^|[^:\\])\/\/[^\n]*/g;
const QUEUE_CALL_RE = /\bqueuePrompt\s*\(/;
const SEND_CALL_RE = /\b(?:sendQueuedPrompts|answerQuestion)\s*\(/;

export const SEND_PATH_WARNING =
  "This artifact calls window.lavish.queuePrompt() but never window.lavish.sendQueuedPrompts() or window.lavish.answerQuestion(), so feedback its own controls queue does not reach you until the reviewer finds Send to Agent. Call sendQueuedPrompts() after queueing when a control should send right away, or answerQuestion() for a store-bound question.";

/**
 * @param {string} html
 * @returns {{ stranded: boolean }}
 */
export function analyzeSendPath(html) {
  const source = (typeof html === "string" ? html : "")
    .replace(HTML_COMMENT_RE, "")
    .replace(BLOCK_COMMENT_RE, "")
    .replace(LINE_COMMENT_RE, "$1");
  return { stranded: QUEUE_CALL_RE.test(source) && !SEND_CALL_RE.test(source) };
}
