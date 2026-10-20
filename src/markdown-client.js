/* global document, window */

// Browser entry for /markdown-assets/markdown.js. Renders every Markdown block in the document:
// `<script type="text/markdown">` (the rendered HTML is inserted after the script) and any element
// carrying `data-lavish-markdown` (its text is replaced by the rendered HTML). Every rendered
// fragment passes through DOMPurify before it reaches the DOM, so raw HTML inside Markdown cannot
// run script. Mermaid fences become diagrams through a lazily loaded mermaid chunk.
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";

const BLOCK_SELECTOR = 'script[type="text/markdown"], [data-lavish-markdown]';
const RENDERED_ATTR = "data-lavish-markdown-rendered";
const MERMAID_CLASS = "lavish-md-mermaid";

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** @param {string} text */
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = String(lang || "")
        .trim()
        .split(/\s+/)[0];
      if (language === "mermaid") {
        return `<div class="${MERMAID_CLASS}">${escapeHtml(text)}</div>\n`;
      }
      const body =
        language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : escapeHtml(text);
      const languageClass = language ? ` language-${escapeHtml(language)}` : "";
      return `<pre><code class="hljs${languageClass}">${body}</code></pre>\n`;
    },
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${escapeHtml(slugify(inner))}">${inner}</h${depth}>\n`;
    },
  },
});

/**
 * Markdown source to sanitized HTML. The only function whose output is assigned to innerHTML.
 * @param {string} source
 */
export function renderMarkdown(source) {
  return DOMPurify.sanitize(/** @type {string} */ (marked.parse(source, { async: false })));
}

/**
 * Block text with the shared indentation of an inline block removed, so Markdown indented to
 * match the surrounding HTML is not read as an indented code block. `<\/script` and `<\!--` are the
 * escapes a `<script type="text/markdown">` body needs to carry those sequences literally.
 * @param {Element} el
 */
function blockSource(el) {
  const raw = (el.textContent || "").replace(/<\\(\/script|!--)/gi, "<$1");
  const lines = raw
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "")
    .split("\n");
  const indents = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const shared = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shared)).join("\n");
}

async function renderMermaid(root) {
  const nodes = [...root.querySelectorAll(`.${MERMAID_CLASS}:not([data-processed])`)];
  if (!nodes.length) return;
  const { default: mermaid } = await import("mermaid");
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  // Natural size, not shrunk to the column: a wide flowchart scrolls instead of becoming unreadable.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
    flowchart: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
  });
  await mermaid.run({ nodes, suppressErrors: true });
}

export async function renderMarkdownBlocks(root = document) {
  for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
    if (el.hasAttribute(RENDERED_ATTR)) continue;
    const html = renderMarkdown(blockSource(el));
    el.setAttribute(RENDERED_ATTR, "");
    if (el.tagName === "SCRIPT") {
      const container = document.createElement("div");
      container.className = "lavish-markdown";
      container.innerHTML = html;
      el.after(container);
    } else {
      el.classList.add("lavish-markdown");
      el.innerHTML = html;
    }
  }
  try {
    await renderMermaid(root);
  } catch (error) {
    console.error("Lavish Markdown: mermaid render failed", error);
  }
  document.documentElement.setAttribute("data-lavish-markdown-ready", "");
}

renderMarkdownBlocks();
