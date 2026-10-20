import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as esbuild from "esbuild";
import { parse } from "parse5";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

const { serve } = await import("../src/server.js");

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("Chrome or Chromium is required: set CHROME_PATH");
}

function dumpChromeDom(chrome, url, profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        `--user-data-dir=${profile}`,
        "--use-mock-keychain",
        "--password-store=basic",
        "--virtual-time-budget=15000",
        "--dump-dom",
        url,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let stdout = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => finish(new Error("Chrome did not dump the DOM in time")), 60_000);
    child.on("error", finish);
    child.on("exit", () => finish(stdout.includes("</html>") ? undefined : new Error("Chrome exited early")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("</html>")) finish();
    });
  });
}

function* walk(node) {
  yield node;
  for (const child of node.childNodes || []) yield* walk(child);
  if (node.content) yield* walk(node.content);
}

const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
const hasClass = (node, name) => (attr(node, "class") || "").split(/\s+/).includes(name);

function renderedFragment(html) {
  const document = parse(html);
  const nodes = [...walk(document)];
  const body = nodes.find((node) => node.nodeName === "body");
  const html_ = nodes.find((node) => node.nodeName === "html");
  const containers = nodes.filter((node) => hasClass(node, "lavish-markdown"));
  const inside = containers.flatMap((container) => [...walk(container)].slice(1));
  return {
    ready: attr(html_, "data-lavish-markdown-ready") !== undefined,
    pwned: attr(body, "data-pwned"),
    containers: containers.length,
    inside,
  };
}

const PAYLOAD = `
<img src="x" onerror="document.body.setAttribute('data-pwned','onerror')">

<script>document.body.setAttribute('data-pwned','script')</script>

[click](javascript:document.body.setAttribute('data-pwned','href'))

<a href="javascript:alert(1)" onclick="alert(1)">raw link</a>
`;

const SPEC = `# Spec title

| Name | Value |
| ---- | ----- |
| alpha | \`1\` |

- [x] shipped
- [ ] pending

\`\`\`js
const answer = 42;
\`\`\`

\`\`\`mermaid
flowchart LR
  A[Start] --> B[End]
\`\`\`

See [the other doc](sub/other.md).
${PAYLOAD}`;

async function startMarkdownServer() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-md-render-"));
  const assetsDir = path.join(dir, "markdown-assets");
  await esbuild.build({
    entryPoints: { markdown: path.join(projectRoot, "src/markdown-client.js") },
    outdir: assetsDir,
    chunkNames: "chunk-[hash]",
    splitting: true,
    bundle: true,
    format: "esm",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const docs = path.join(dir, "docs");
  await mkdir(path.join(docs, "sub"), { recursive: true });
  await writeFile(path.join(docs, "spec.md"), SPEC);
  await writeFile(path.join(docs, "sub", "other.md"), "# Other\n\nBack to [spec](../spec.md).\n");
  // A data-lavish-markdown element's children are parsed as HTML before the renderer runs, so its
  // payload is plain Markdown; the raw-text <script type="text/markdown"> block carries the attack.
  await writeFile(
    path.join(docs, "embed.html"),
    `<!doctype html><html><body><h1>Host page</h1>
<div data-lavish-markdown>
    | Embedded | Table |
    | -------- | ----- |
    | x        | y     |
</div>
<script type="text/markdown">
- [x] from a script block
${PAYLOAD.replaceAll("</script>", "<\\/script>")}
</script>
<script type="module" src="/markdown-assets/markdown.js"></script>
</body></html>`,
  );
  await writeFile(path.join(dir, "md-roots.json"), JSON.stringify({ roots: { docs } }));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    markdownAssetsDir: assetsDir,
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    dir,
    base,
    docs,
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function assertSanitized(fragment) {
  assert.equal(fragment.pwned, undefined, "a Markdown payload ran script");
  for (const node of fragment.inside) {
    assert.notEqual(node.nodeName, "script", "a <script> element survived sanitization");
    for (const { name, value } of node.attrs || []) {
      assert.ok(!/^on/i.test(name), `event handler attribute ${name} survived sanitization`);
      assert.ok(!/^\s*javascript:/i.test(value), `javascript: URL survived in ${name}`);
    }
  }
}

test(
  "a .md file under a Markdown root renders GFM, code, mermaid and strips script payloads",
  { timeout: 120_000 },
  async () => {
    const chrome = await chromePath();
    const env = await startMarkdownServer();
    try {
      const dom = await dumpChromeDom(chrome, `${env.base}/md/docs/spec.md`, path.join(env.dir, "profile-a"));
      const fragment = renderedFragment(dom);
      assert.equal(fragment.ready, true, "renderer did not finish");
      assert.equal(fragment.containers, 1);
      const names = fragment.inside.map((node) => node.nodeName);
      assert.ok(names.includes("table"), "GFM table not rendered");
      assert.equal(fragment.inside.filter((node) => attr(node, "type") === "checkbox").length, 2);
      assert.ok(
        fragment.inside.some((node) => hasClass(node, "hljs-keyword")),
        "fenced js code not highlighted",
      );
      const mermaid = fragment.inside.find((node) => hasClass(node, "lavish-md-mermaid"));
      assert.ok(mermaid && [...walk(mermaid)].some((node) => node.nodeName === "svg"), "mermaid fence not drawn");
      const link = fragment.inside.find((node) => node.nodeName === "a" && attr(node, "href") === "sub/other.md");
      assert.ok(link, "relative .md link lost");
      assertSanitized(fragment);
    } finally {
      await env.close();
    }
  },
);

test(
  "Markdown blocks embedded in an HTML page render client-side and stay sanitized",
  { timeout: 120_000 },
  async () => {
    const chrome = await chromePath();
    const env = await startMarkdownServer();
    try {
      // The page is served raw by a static route so only the client renderer is under test.
      const { createServer } = await import("node:http");
      const { readFile } = await import("node:fs/promises");
      const page = await readFile(path.join(env.docs, "embed.html"), "utf8");
      const proxy = createServer(async (req, res) => {
        if (req.url === "/") {
          res.writeHead(200, { "content-type": "text/html" }).end(page);
          return;
        }
        const upstream = await fetch(`${env.base}${req.url}`);
        res
          .writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "" })
          .end(Buffer.from(await upstream.arrayBuffer()));
      });
      await new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve(undefined)));
      try {
        const { port } = /** @type {import("node:net").AddressInfo} */ (proxy.address());
        const dom = await dumpChromeDom(chrome, `http://127.0.0.1:${port}/`, path.join(env.dir, "profile-b"));
        const fragment = renderedFragment(dom);
        assert.equal(fragment.ready, true, "renderer did not finish");
        assert.equal(fragment.containers, 2, "both the data-lavish-markdown element and the script block render");
        assert.ok(
          fragment.inside.some((node) => node.nodeName === "table"),
          "indented embedded table not rendered",
        );
        assert.ok(
          fragment.inside.some((node) => attr(node, "type") === "checkbox"),
          "script block not rendered",
        );
        assertSanitized(fragment);
      } finally {
        proxy.closeAllConnections();
        await new Promise((resolve) => proxy.close(resolve));
      }
    } finally {
      await env.close();
    }
  },
);
