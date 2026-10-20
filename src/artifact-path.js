import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export const ARTIFACT_HTML_ERROR = "Lavish Editor expects an HTML or Markdown file";

/**
 * Match the CLI: `.html` / `.htm` (any case) are HTML artifacts.
 * @param {unknown} file
 * @returns {boolean}
 */
export function isHtmlPath(file) {
  const lower = String(file || "").toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

/**
 * `.md` / `.markdown` (any case) are Markdown artifacts, served as a rendered HTML shell.
 * @param {unknown} file
 * @returns {boolean}
 */
export function isMarkdownPath(file) {
  const lower = String(file || "").toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/**
 * Every file type Lavish opens as a review session.
 * @param {unknown} file
 * @returns {boolean}
 */
export function isArtifactPath(file) {
  return isHtmlPath(file) || isMarkdownPath(file);
}

/**
 * Directory `/artifact/:key/*` may read: the canonical HTML file's own directory.
 * A caller cannot pick a different tree by registering a non-HTML path.
 * @param {string} file
 * @returns {string}
 */
export function artifactTreeRoot(file) {
  return path.dirname(file);
}

export class ArtifactPathError extends Error {
  /** @type {"VALIDATION_ERROR"} */
  code = "VALIDATION_ERROR";
  /** @type {400} */
  statusCode = 400;

  /**
   * @param {string} [message]
   */
  constructor(message = ARTIFACT_HTML_ERROR) {
    super(message);
    this.name = "ArtifactPathError";
  }
}

/**
 * @param {unknown} error
 * @returns {error is ArtifactPathError}
 */
export function isArtifactPathError(error) {
  return error instanceof Error && error.name === "ArtifactPathError";
}

/**
 * Canonicalize a session-create path and refuse anything that is not a regular HTML or Markdown file.
 * The request name and the symlink-followed real path both have to be artifacts, so
 * `preview.html -> /etc/passwd` cannot adopt `/etc` as a serving tree.
 * @param {unknown} file
 * @returns {Promise<string>}
 */
export async function resolveAllowedArtifactFile(file) {
  const requested = typeof file === "string" ? file : "";
  if (!isArtifactPath(requested)) {
    throw new ArtifactPathError();
  }
  const canonical = await realpath(path.resolve(requested));
  if (!isArtifactPath(canonical)) {
    throw new ArtifactPathError();
  }
  const info = await stat(canonical);
  if (!info.isFile()) {
    throw new ArtifactPathError();
  }
  return canonical;
}
