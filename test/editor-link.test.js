import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import test from "node:test";

import {
  buildEditorUri,
  isLocalViewer,
  resolveEditorPath,
  resolveEditorRoots,
  resolveEditorSshHost,
} from "../src/editor-link.js";
import { serve } from "../src/server.js";

async function withTree(fn) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-editor-")));
  const repo = path.join(base, "repo");
  const outside = path.join(base, "outside");
  await mkdir(path.join(repo, "docs", "spec"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(repo, "docs", "spec", "plan.md"), "# plan\n");
  await writeFile(path.join(outside, "secret.txt"), "no\n");
  await symlink(path.join(outside, "secret.txt"), path.join(repo, "escape.txt"));
  try {
    await fn({ base, repo, outside });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/**
 * @param {{ file?: unknown, root?: unknown }} request
 * @param {string[]} roots
 */
async function refusal(request, roots) {
  const result = await resolveEditorPath(request, { roots });
  assert.equal(result.ok, false, JSON.stringify(request));
  return result.ok ? "" : result.error;
}

test("a relative path resolves against the page-named root", async () => {
  await withTree(async ({ repo }) => {
    const result = await resolveEditorPath({ file: "docs/spec/plan.md", root: repo }, { roots: [repo] });
    assert.deepEqual(result, { ok: true, path: path.join(repo, "docs", "spec", "plan.md") });
  });
});

test("paths that leave the allowed roots are refused", async () => {
  await withTree(async ({ base, repo, outside }) => {
    const roots = [repo];
    assert.match(await refusal({ file: "../outside/secret.txt", root: repo }, roots), /escapes its root/);
    assert.match(await refusal({ file: "escape.txt", root: repo }, roots), /outside the allowed/, "symlink target");
    assert.match(await refusal({ file: path.join(outside, "secret.txt") }, roots), /outside the allowed/);
    assert.match(await refusal({ file: "secret.txt", root: outside }, roots), /root is outside/);
    assert.match(await refusal({ file: "repo/docs/spec/plan.md", root: base }, roots), /root is outside/);
  });
});

test("a relative path without a usable root is refused", async () => {
  await withTree(async ({ repo }) => {
    const roots = [repo];
    assert.match(await refusal({ file: "docs/spec/plan.md" }, roots), /needs a root/);
    assert.match(await refusal({ file: "plan.md", root: "docs" }, roots), /absolute/);
    assert.match(await refusal({ file: "plan.md", root: path.join(repo, "missing") }, roots), /root does not exist/);
    assert.match(await refusal({ file: "nope.md", root: repo }, roots), /does not exist/);
    assert.match(await refusal({ file: "docs", root: repo }, roots), /not a file/);
    assert.match(await refusal({ file: "" }, roots), /no file/);
  });
});

test("the URI targets Remote-SSH only when a host is given, with each segment encoded", () => {
  assert.equal(
    buildEditorUri("/home/me/src/a b/#1.md", { sshHost: "devbox", line: "12" }),
    "vscode://vscode-remote/ssh-remote+devbox/home/me/src/a%20b/%231.md:12",
  );
  assert.equal(buildEditorUri("/Users/me/x.md", { line: "" }), "vscode://file/Users/me/x.md");
  assert.equal(buildEditorUri("/Users/me/x.md", { line: "-3" }), "vscode://file/Users/me/x.md");
  assert.throws(() => buildEditorUri("relative.md"));
});

test("a viewer is local only from a local address under one of this machine's names", () => {
  const machine = { localAddresses: ["100.64.0.9"], ownHostnames: ["box"] };
  assert.equal(isLocalViewer({ remoteAddress: "127.0.0.1", hostname: "localhost" }, machine), true);
  assert.equal(isLocalViewer({ remoteAddress: "::ffff:127.0.0.1", hostname: "127.0.0.1" }, machine), true);
  assert.equal(isLocalViewer({ remoteAddress: "::1", hostname: "[::1]" }, machine), true);
  assert.equal(isLocalViewer({ remoteAddress: "100.64.0.9", hostname: "BOX" }, machine), true);
  assert.equal(isLocalViewer({ remoteAddress: "100.64.0.7", hostname: "box" }, machine), false, "remote address");
  assert.equal(
    isLocalViewer({ remoteAddress: "127.0.0.1", hostname: "mac.tail.ts.net" }, machine),
    false,
    "an SSH port forward arrives over loopback under the viewer's name",
  );
  assert.equal(isLocalViewer({ remoteAddress: undefined, hostname: "localhost" }, machine), false);
});

test("roots and SSH host come from the environment with home and hostname as defaults", () => {
  assert.deepEqual(resolveEditorRoots({}, "/home/me"), ["/home/me"]);
  assert.deepEqual(resolveEditorRoots({ LAVISH_EDITOR_ROOTS: `/a${path.delimiter}rel${path.delimiter}/b/` }, "/h"), [
    "/a",
    "/b",
  ]);
  assert.equal(resolveEditorSshHost({ LAVISH_EDITOR_SSH_HOST: " devbox " }), "devbox");
  assert.ok(resolveEditorSshHost({}).length > 0);
});

test("the editor-link route returns a local URI and refuses traversal and foreign origins", async () => {
  await withTree(async ({ base, repo }) => {
    const artifact = path.join(base, "page.html");
    await writeFile(artifact, "<!doctype html><html><body>page</body></html>");
    const env = {
      ...process.env,
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
      LAVISH_EDITOR_ROOTS: repo,
      LAVISH_EDITOR_SSH_HOST: "devbox",
      LAVISH_AXI_ALLOWED_HOSTS: "viewer.example.ts.net",
    };
    const server = await serve({ env, port: 0, stateFile: path.join(base, "server.json"), version: "9.9.9-test" });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const { key } = await fetch(`${origin}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: artifact }),
      }).then((response) => response.json());
      /** @type {(body: Record<string, string>, headers?: Record<string, string>) => Promise<Response>} */
      const ask = (body, headers = { origin }) =>
        fetch(`${origin}/api/${key}/editor-link`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      const ok = await ask({ path: "docs/spec/plan.md", root: repo, line: "3" });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), {
        uri: buildEditorUri(path.join(repo, "docs", "spec", "plan.md"), { line: 3 }),
        path: path.join(repo, "docs", "spec", "plan.md"),
        remote: false,
      });
      assert.equal((await ask({ path: "../outside/secret.txt", root: repo })).status, 400);
      assert.equal((await ask({ path: "docs/spec/plan.md" })).status, 400);
      assert.equal((await ask({ path: artifact })).status, 200, "the page's own directory is allowed");
      assert.equal((await ask({ path: "docs/spec/plan.md", root: repo }, {})).status, 403);
      const forwarded = await postViaHost(server.port, "viewer.example.ts.net", `/api/${key}/editor-link`, {
        path: "docs/spec/plan.md",
        root: repo,
      });
      assert.equal(forwarded.uri, buildEditorUri(path.join(repo, "docs", "spec", "plan.md"), { sshHost: "devbox" }));
      assert.equal(forwarded.remote, true);
    } finally {
      await server.close();
    }
  });
});

// fetch() cannot set Host, and a forwarded viewer is exactly a loopback connection under another name.
function postViaHost(port, host, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          host: `${host}:${port}`,
          origin: `http://${host}:${port}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(JSON.parse(text)));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}
