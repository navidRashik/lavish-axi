/* global document, window, getComputedStyle, MutationObserver */

// Browser entry for /markdown-assets/markdown.js. Renders every Markdown block in the document:
// `<script type="text/markdown">` (the rendered HTML is inserted after the script) and any element
// carrying `data-lavish-markdown` (its text is replaced by the rendered HTML). Every rendered
// fragment passes through DOMPurify before it reaches the DOM, so raw HTML inside Markdown cannot
// run script. Mermaid fences become diagrams through a lazily loaded mermaid chunk.
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";

import { mermaidThemeFor } from "./markdown-theme.js";

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
function renderMarkdown(source) {
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

const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
/** @type {WeakMap<Element, string>} the escaped fence text each diagram was drawn from */
const mermaidSources = new WeakMap();
/** @type {WeakMap<Element, string>} the mermaid theme each diagram is currently drawn in */
const mermaidThemes = new WeakMap();
/** @type {any} */
let mermaid;
/** @type {CanvasRenderingContext2D | null} */
let paint = null;

/**
 * Any CSS colour the browser computes (rgb, oklch, color-mix, ...) as [r, g, b, a] bytes.
 * @param {string} color
 */
function toRgba(color) {
  paint ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!paint) return [0, 0, 0, 0];
  paint.clearRect(0, 0, 1, 1);
  paint.fillStyle = "#000";
  paint.fillStyle = color;
  paint.fillRect(0, 0, 1, 1);
  return [...paint.getImageData(0, 0, 1, 1).data];
}

/**
 * The mermaid theme for the surface under `el`.
 * @param {Element} el
 */
function surfaceTheme(el) {
  const backgrounds = [];
  for (let node = /** @type {Element | null} */ (el); node; node = node.parentElement) {
    const rgba = toRgba(getComputedStyle(node).backgroundColor);
    backgrounds.push(rgba);
    if (rgba[3] === 255) break;
  }
  return mermaidThemeFor({
    backgrounds,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    prefersDark: Boolean(darkQuery?.matches),
  });
}

/**
 * Draws every mermaid fence in the theme of the surface under it, redrawing a diagram whose surface
 * changed between light and dark since it was last drawn. Mermaid never restyles a drawn SVG.
 */
async function drawMermaid() {
  const nodes = [...document.querySelectorAll(`.${MERMAID_CLASS}`)];
  /** @type {Record<string, Element[]>} */
  const byTheme = { default: [], dark: [] };
  for (const node of nodes) {
    if (!mermaidSources.has(node)) mermaidSources.set(node, node.innerHTML);
    const theme = surfaceTheme(node);
    if (mermaidThemes.get(node) === theme) continue;
    node.removeAttribute("data-processed");
    node.innerHTML = /** @type {string} */ (mermaidSources.get(node));
    byTheme[theme].push(node);
  }
  if (!byTheme.default.length && !byTheme.dark.length) return;
  // One sibling bundle rather than mermaid's per-diagram chunks: a remote viewer pays one round trip.
  mermaid ??= (await import(new URL("./mermaid.js", import.meta.url).href)).default;
  for (const [theme, group] of Object.entries(byTheme)) {
    if (!group.length) continue;
    // Natural size, not shrunk to the column: a wide flowchart scrolls instead of becoming unreadable.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
    });
    await mermaid.run({ nodes: group, suppressErrors: true });
    for (const node of group) mermaidThemes.set(node, theme);
  }
}

let mermaidRun = Promise.resolve();
let mermaidQueued = false;

/** Serialises draws; requests made while one is waiting to start share it. */
function queueMermaid() {
  if (mermaidQueued) return mermaidRun;
  mermaidQueued = true;
  mermaidRun = mermaidRun
    .then(() => {
      mermaidQueued = false;
      return drawMermaid();
    })
    .catch((error) => console.error("Lavish Markdown: mermaid render failed", error));
  return mermaidRun;
}

function watchSurfaceTheme() {
  const redraw = () => void queueMermaid();
  const observer = new MutationObserver(redraw);
  for (const el of [document.documentElement, document.body]) {
    if (el) observer.observe(el, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  }
  darkQuery?.addEventListener("change", redraw);
  document.addEventListener("change", redraw, true);
  document.addEventListener(
    "transitionend",
    ({ propertyName }) => {
      if (propertyName === "background-color") redraw();
    },
    true,
  );
  if (document.readyState !== "complete") window.addEventListener("load", redraw, { once: true });
}

async function renderMarkdownBlocks(root = document) {
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
  await queueMermaid();
  if (document.querySelector(`.${MERMAID_CLASS}`)) watchSurfaceTheme();
  document.documentElement.setAttribute("data-lavish-markdown-ready", "");
}

renderMarkdownBlocks();
