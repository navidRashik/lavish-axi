import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse } from "parse5";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

const { serve } = await import("../src/server.js");
const { createMarkdownShellHtml, hasMarkdownBlocks, markdownRoutePath, readMarkdownRoots, writeMarkdownRoot } =
  await import("../src/markdown-page.js");

function chromeSessionData(html) {
  const match = String(html).match(/<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match);
  return JSON.parse(match[1]);
}

// fetch() normalizes dot segments away; this sends the path exactly as written.
function rawStatus(base, rawPath) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    httpGet({ host: "127.0.0.1", port, path: rawPath, headers: { accept: "text/html" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
}

async function startServer() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-md-server-")));
  const assets = path.join(dir, "assets");
  await mkdir(assets);
  await writeFile(path.join(assets, "markdown.js"), "// bundle\n");
  const docs = path.join(dir, "docs");
  const outside = path.join(dir, "outside");
  await mkdir(path.join(docs, "sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(docs, "spec.md"), "# Spec title\n\nBody with </script><b>raw</b>\n");
  await writeFile(path.join(docs, "sub", "other.md"), "# Other\n");
  await writeFile(path.join(docs, "pic.png"), "png");
  await writeFile(path.join(docs, "notes.js"), "secret()");
  await writeFile(path.join(docs, ".hidden.md"), "# hidden\n");
  await writeFile(path.join(outside, "secret.md"), "# secret\n");
  await symlink(outside, path.join(docs, "escape"));
  await writeFile(
    path.join(docs, "embed.html"),
    '<!doctype html><html><body><script type="text/markdown"># hi</script></body></html>',
  );
  await writeFile(path.join(docs, "plain.html"), "<!doctype html><html><body><p>plain</p></body></html>");
  await writeFile(
    path.join(docs, "src.html"),
    '<!doctype html><html><body><div data-lavish-markdown-src="spec.md"></div><div data-lavish-markdown-src="escape/secret.md"></div><div data-lavish-markdown-src="../outside/secret.md"></div></body></html>',
  );
  await writeMarkdownRoot(path.join(dir, "md-roots.json"), "docs", docs);
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    markdownAssetsDir: assets,
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    dir,
    docs,
    base,
    async open(file) {
      const opened = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      });
      assert.equal(opened.status, 200);
      return (await opened.json()).key;
    },
    async artifact(key) {
      const chromeHtml = await fetch(`${base}/session/${key}`).then((res) => res.text());
      const chrome = chromeSessionData(chromeHtml);
      const load = await fetch(`${base}/api/${key}/artifact-loads/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: `md-${key}`,
          request_sequence: chrome.initialArtifactLoadSequence + 1,
          chrome_load_token: chrome.chromeLoadToken,
        }),
      }).then((res) => res.json());
      const query = `artifact_revision=${load.artifact_revision}&artifact_load_token=${encodeURIComponent(load.artifact_load_token)}`;
      return { chromeHtml, html: await fetch(`${base}/artifact/${key}/index.html?${query}`).then((res) => res.text()) };
    },
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function scriptTexts(html, type) {
  const out = [];
  /** @type {any[]} */
  const stack = [parse(html)];
  while (stack.length) {
    const node = stack.pop();
    if (node.nodeName === "script" && node.attrs.some((a) => a.name === "type" && a.value === type)) {
      out.push(node.childNodes.map((child) => child.value).join(""));
    }
    stack.push(...(node.childNodes || []));
  }
  return out;
}

test("the Markdown shell keeps a source containing </script and <!-- inside one raw-text block", () => {
  const source = "# T\n\n</script><img src=x onerror=alert(1)>\n<!-- <script> -->\n</SCRIPT >tail";
  const [text] = scriptTexts(createMarkdownShellHtml(source, { title: "<T>" }), "text/markdown");
  assert.equal(text.replace(/<\\(\/script|!--)/gi, "<$1").trim(), source);
});

test("hasMarkdownBlocks finds script and attribute blocks but not commented or lookalike ones", () => {
  assert.equal(hasMarkdownBlocks('<script type="text/markdown">x</script>'), true);
  assert.equal(hasMarkdownBlocks("<div data-lavish-markdown>x</div>"), true);
  assert.equal(hasMarkdownBlocks('<!-- <script type="text/markdown"> -->'), false);
  assert.equal(hasMarkdownBlocks("<div data-lavish-markdowns>x</div>"), false);
  assert.equal(hasMarkdownBlocks("<p>text/markdown</p>"), false);
});

test("markdownRoutePath picks the most specific root and refuses files outside every root", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-md-roots-")));
  try {
    await mkdir(path.join(dir, "a", "b c"), { recursive: true });
    const file = path.join(dir, "md-roots.json");
    await writeMarkdownRoot(file, "outer", dir);
    await writeMarkdownRoot(file, "inner", path.join(dir, "a"));
    const roots = await readMarkdownRoots(file);
    assert.equal(await markdownRoutePath(roots, path.join(dir, "a", "b c", "x.md")), "/md/inner/b%20c/x.md");
    assert.equal(await markdownRoutePath(roots, path.join(dir, "y.md")), "/md/outer/y.md");
    assert.equal(await markdownRoutePath(roots, path.join(path.dirname(dir), "z.md")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/md/ serves rendered Markdown and images under a root and refuses everything else", async () => {
  const env = await startServer();
  try {
    const get = (p) => fetch(`${env.base}${p}`, { headers: { accept: "text/html" } });
    const spec = await get("/md/docs/spec.md");
    assert.equal(spec.status, 200);
    assert.match(spec.headers.get("content-security-policy") || "", /sandbox/);
    const shell = await spec.text();
    assert.match(shell, /<title>Spec title<\/title>/);
    assert.match(shell, /src="\/markdown-assets\/markdown\.js"/);
    assert.equal((await get("/md/docs/sub/other.md")).status, 200);
    assert.equal((await get("/md/docs/pic.png")).status, 200);
    for (const refused of [
      "/md/docs/..%2Foutside%2Fsecret.md",
      "/md/docs/%2e%2e/outside/secret.md",
      "/md/docs/../outside/secret.md",
      "/md/docs/sub/..%2F..%2Foutside%2Fsecret.md",
      "/md/docs/.hidden.md",
      "/md/docs/notes.js",
      "/md/docs/escape/secret.md",
    ]) {
      assert.equal(await rawStatus(env.base, refused), 403, refused);
    }
    assert.equal((await get("/md/nope/spec.md")).status, 404);
    assert.equal((await get("/md/docs/missing.md")).status, 404);
  } finally {
    await env.close();
  }
});

test("/api/markdown-url answers the tailnet URL only for files under a configured root", async () => {
  const env = await startServer();
  try {
    const ask = (file) => fetch(`${env.base}/api/markdown-url?file=${encodeURIComponent(file)}`);
    const ok = await ask(path.join(env.docs, "sub", "other.md"));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { url: `${env.base}/md/docs/sub/other.md` });
    assert.equal((await ask(path.join(env.dir, "outside", "secret.md"))).status, 404);
    assert.equal((await ask("relative.md")).status, 400);
  } finally {
    await env.close();
  }
});

test("a .md session serves the rendered shell with the SDK, and its export is refused", async () => {
  const env = await startServer();
  try {
    const key = await env.open(path.join(env.docs, "spec.md"));
    const { chromeHtml, html } = await env.artifact(key);
    assert.match(chromeHtml, /<title>Spec title · Lavish<\/title>/);
    assert.match(html, /\/sdk\.js\?key=/);
    const [text] = scriptTexts(html, "text/markdown");
    assert.match(text, /Body with <\\\/script><b>raw<\/b>/);
    assert.equal(html.match(/\/markdown-assets\/markdown\.js/g)?.length, 1);
    assert.equal((await fetch(`${env.base}/api/${key}/export`)).status, 409);
  } finally {
    await env.close();
  }
});

test("a .md link inside an artifact opens rendered on navigation and raw for a fetch", async () => {
  const env = await startServer();
  try {
    const key = await env.open(path.join(env.docs, "plain.html"));
    const navigated = await fetch(`${env.base}/artifact/${key}/sub/other.md`, { headers: { accept: "text/html" } });
    assert.match(await navigated.text(), /<script type="text\/markdown">/);
    const fetched = await fetch(`${env.base}/artifact/${key}/sub/other.md`, { headers: { accept: "*/*" } });
    assert.equal(await fetched.text(), "# Other\n");
  } finally {
    await env.close();
  }
});

test("the renderer is injected into HTML artifacts with Markdown blocks only", async () => {
  const env = await startServer();
  try {
    const embedded = await env.artifact(await env.open(path.join(env.docs, "embed.html")));
    assert.match(embedded.html, /src="\/markdown-assets\/markdown\.js"/);
    const plain = await env.artifact(await env.open(path.join(env.docs, "plain.html")));
    assert.doesNotMatch(plain.html, /markdown-assets/);
    const asset = await fetch(`${env.base}/markdown-assets/markdown.js`);
    assert.equal(asset.headers.get("access-control-allow-origin"), "*");
  } finally {
    await env.close();
  }
});

test("data-lavish-markdown-src inlines a .md from the artifact tree and nothing outside it", async () => {
  const env = await startServer();
  try {
    const { html } = await env.artifact(await env.open(path.join(env.docs, "src.html")));
    const blocks = scriptTexts(html, "text/markdown");
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /^# Spec title/m);
    assert.doesNotMatch(html, /# secret/);
    assert.match(html, /src="\/markdown-assets\/markdown\.js"/);
  } finally {
    await env.close();
  }
});
