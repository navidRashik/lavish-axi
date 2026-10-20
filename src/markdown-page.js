import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MARKDOWN_ASSET_TAGS =
  '<link rel="stylesheet" href="/markdown-assets/markdown.css">\n<script type="module" src="/markdown-assets/markdown.js"></script>';

const MARKDOWN_BLOCK_PATTERN =
  /<script\b[^>]*\btype\s*=\s*["']?text\/markdown\b|<[a-z][^>]*\sdata-lavish-markdown(?=[\s=/>])/i;

const MARKDOWN_SRC_TAG = /<[a-z][\w-]*\b[^>]*?\sdata-lavish-markdown-src\s*=\s*(["'])([^"'<>]+)\1[^>]*>/gi;

/**
 * Inline the file each `data-lavish-markdown-src="<relative .md>"` element names as a Markdown
 * block right after its opening tag, so the browser renders it with no cross-origin fetch.
 * `resolve` confines a path to the artifact tree and returns null outside it; a path that is not
 * Markdown, is refused, or cannot be read leaves the element as written.
 * @param {string} html
 * @param {(relative: string) => Promise<string | null>} resolve
 */
export async function inlineMarkdownSources(html, resolve) {
  if (typeof html !== "string" || !html.includes("data-lavish-markdown-src")) return html;
  const parts = [];
  let last = 0;
  for (const match of html.matchAll(MARKDOWN_SRC_TAG)) {
    const end = (match.index ?? 0) + match[0].length;
    parts.push(html.slice(last, end));
    last = end;
    const relative = match[2].trim();
    if (!/\.(md|markdown)$/i.test(relative)) continue;
    const file = await resolve(relative).catch(nullWhenMissing);
    const source = file ? await readFile(file, "utf8").catch(nullWhenMissing) : null;
    if (source !== null) parts.push(`<script type="text/markdown">\n${escapeMarkdownScriptBody(source)}\n</script>`);
  }
  parts.push(html.slice(last));
  return parts.join("");
}

/**
 * A missing path is an expected answer (null); any other filesystem error propagates.
 * @param {NodeJS.ErrnoException} error
 */
function nullWhenMissing(error) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
  throw error;
}

/**
 * `</script` and `<!--` are the only sequences that can end or derail a raw-text script body;
 * they are written as `<\/script` / `<\!--`, which the renderer reverses.
 * @param {string} source
 */
function escapeMarkdownScriptBody(source) {
  return source.replace(/<(\/script|!--)/gi, "<\\$1");
}

// Built from a string: `<!--` inside a regex literal is an Annex B HTML comment to some JS parsers.
const HTML_COMMENT_PATTERN = new RegExp("<!--[\\s\\S]*?-->", "g");

/**
 * Whether an HTML document carries a Markdown block the renderer has to load for.
 * @param {string} html
 */
export function hasMarkdownBlocks(html) {
  return typeof html === "string" && MARKDOWN_BLOCK_PATTERN.test(html.replace(HTML_COMMENT_PATTERN, ""));
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Title for a Markdown document: its first ATX `# ` heading, else the file name.
 * @param {string} source
 * @param {string} file
 */
function markdownTitle(source, file) {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(source);
  return heading ? heading[1] : path.basename(file);
}

/**
 * A standalone HTML page that renders `source` client-side from a `<script type="text/markdown">`.
 * @param {string} source
 * @param {{ title: string }} options
 */
export function createMarkdownShellHtml(source, { title }) {
  const body = escapeMarkdownScriptBody(source);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/markdown-assets/markdown.css">
</head>
<body class="lavish-markdown-page">
<main>
<script type="text/markdown">
${body}
</script>
</main>
<script type="module" src="/markdown-assets/markdown.js"></script>
</body>
</html>
`;
}

/**
 * @param {string} file
 */
export async function readMarkdownShellHtml(file) {
  const source = await readFile(file, "utf8");
  return createMarkdownShellHtml(source, { title: markdownTitle(source, file) });
}

const ROOT_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** @param {unknown} alias */
export function isValidMarkdownRootAlias(alias) {
  return typeof alias === "string" && ROOT_ALIAS_PATTERN.test(alias);
}

/**
 * The allow-list of directories `/md/<alias>/...` may serve, kept beside state.json.
 * @param {string} stateDirectory
 */
export function markdownRootsFile(stateDirectory) {
  return path.join(stateDirectory, "md-roots.json");
}

/**
 * Configured roots as alias -> absolute directory. A missing file means no roots, so the route
 * serves nothing; a file that cannot be parsed throws rather than silently disabling every root.
 * Entries with an invalid alias or a relative path are dropped.
 * @param {string} file
 * @returns {Promise<Map<string, string>>}
 */
export async function readMarkdownRoots(file) {
  const roots = new Map();
  const text = await readFile(file, "utf8").catch(nullWhenMissing);
  if (text === null) return roots;
  const parsed = JSON.parse(text);
  const entries = parsed && typeof parsed.roots === "object" && parsed.roots ? Object.entries(parsed.roots) : [];
  for (const [alias, dir] of entries) {
    if (isValidMarkdownRootAlias(alias) && typeof dir === "string" && path.isAbsolute(dir)) roots.set(alias, dir);
  }
  return roots;
}

/**
 * Add or replace one root. The directory is stored as its real path.
 * @param {string} file
 * @param {string} alias
 * @param {string} dir
 */
export async function writeMarkdownRoot(file, alias, dir) {
  const roots = Object.fromEntries(await readMarkdownRoots(file));
  roots[alias] = await realpath(path.resolve(dir));
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ roots }, null, 2)}\n`);
  await rename(temp, file);
  return roots[alias];
}

/**
 * The `/md/<alias>/<path>` URL path for a file, under the configured root that holds it most
 * specifically, or null when no root holds it.
 * @param {Map<string, string>} roots
 * @param {string} file absolute real path
 */
export async function markdownRoutePath(roots, file) {
  let best = null;
  for (const [alias, dir] of roots) {
    const realDir = await realpath(dir).catch(nullWhenMissing);
    if (!realDir) continue;
    const relative = path.relative(realDir, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (!best || realDir.length > best.dir.length) best = { alias, dir: realDir, relative };
  }
  if (!best) return null;
  const encoded = best.relative.split(path.sep).map(encodeURIComponent).join("/");
  return `/md/${encodeURIComponent(best.alias)}/${encoded}`;
}

// What `/md/` serves besides Markdown: images a document references by relative path.
const MARKDOWN_ROUTE_ASSET_TYPES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

/**
 * Whether a `/md/` relative path names a servable file: no empty, dot or dot-prefixed segment
 * (no traversal, no hidden files) and a Markdown or image extension.
 * @param {string} relative decoded, `/`-separated
 */
export function isServableMarkdownRoutePath(relative) {
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment.startsWith(".") || segment.includes("\\"))) return false;
  const lower = relative.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || MARKDOWN_ROUTE_ASSET_TYPES.has(path.extname(lower));
}
