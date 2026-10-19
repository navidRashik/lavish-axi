import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { serve } from "../src/server.js";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ITEM = "pr:x/y#1";

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
  return "";
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A small Chrome DevTools Protocol client over one browser connection with flattened sessions.
// The artifact iframe is sandboxed to an opaque origin, so its DOM is unreachable from the chrome
// page's JavaScript; CDP evaluates inside the frame's own execution context instead.
async function launchChrome(chrome, profile) {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=IsolateSandboxedIframes",
      "--disable-site-isolation-trials",
      "--window-size=1200,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 15_000;
  let endpoint = "";
  while (!endpoint && Date.now() < deadline) {
    const text = await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    const [port, wsPath] = text.trim().split("\n");
    if (port && wsPath) endpoint = `ws://127.0.0.1:${port}${wsPath}`;
    else await delay(50);
  }
  assert.ok(endpoint, "Chrome exposed a DevTools endpoint");
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}`));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  async function openPage(url) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    /** @type {Map<number, string>} */
    const contexts = new Map();
    /** @type {Map<string, string>} */
    const frameSessions = new Map();
    listeners.push((message) => {
      if (message.method === "Target.attachedToTarget" && message.sessionId === sessionId) {
        const child = message.params;
        if (child.targetInfo.type === "iframe") {
          frameSessions.set(child.targetInfo.targetId, child.sessionId);
          send("Runtime.runIfWaitingForDebugger", {}, child.sessionId).catch(() => {});
        }
      }
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.executionContextCreated") {
        const context = message.params.context;
        if (context.auxData?.isDefault) contexts.set(context.id, context.auxData.frameId);
      }
      if (message.method === "Runtime.executionContextDestroyed") contexts.delete(message.params.executionContextId);
      if (message.method === "Runtime.executionContextsCleared") contexts.clear();
    });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    await send("Page.navigate", { url }, sessionId);

    async function artifactFrameId() {
      const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
      const child = (frameTree.childFrames || []).find((entry) => entry.frame.url.includes("/artifact/"));
      return child?.frame.id || "";
    }

    // Evaluate `expression` in the artifact frame's main world; null while it is not ready.
    async function frameEval(expression) {
      const frameId = await artifactFrameId();
      if (!frameId) return null;
      const params = { expression, returnByValue: true, awaitPromise: true };
      try {
        if (frameSessions.has(frameId)) {
          const result = await send("Runtime.evaluate", params, frameSessions.get(frameId));
          return result.exceptionDetails ? null : result.result.value;
        }
        const contextId = [...contexts].filter(([, owner]) => owner === frameId).at(-1)?.[0];
        if (!contextId) return null;
        const result = await send("Runtime.evaluate", { ...params, contextId }, sessionId);
        return result.exceptionDetails ? null : result.result.value;
      } catch {
        return null;
      }
    }

    async function waitFor(expression, predicate, label, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await frameEval(expression);
        if (predicate(last)) return last;
        await delay(50);
      }
      throw new Error(`${label}: last value ${JSON.stringify(last)}`);
    }

    return { frameEval, waitFor };
  }

  return {
    openPage,
    async close() {
      socket.close();
      child.kill("SIGKILL");
    },
  };
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "bin/lavish-axi.js"), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const QUESTION = (prefix) =>
  `<fieldset id="q" data-lavish-question="merge" data-lavish-ref="q:merge"><label><input id="${prefix}Yes" type="radio" name="m" value="yes">Yes</label><button id="${prefix}Send" type="button">Queue answer</button></fieldset>`;

const PAGE_A = `<!doctype html><html><head><title>A</title><style>[role=tabpanel]:not(.active){display:none}</style></head><body>
<nav role="tablist"><a id="tab1" href="#t1" role="tab">One</a> <a id="tab2" href="#t2" role="tab">Two</a> <a id="tabAway" href="/elsewhere" role="tab">Away</a></nav>
<section id="t1" role="tabpanel" class="active"><span id="s1" data-lavish-ref="${ITEM}" data-lavish-field="status">draft</span></section>
<section id="t2" role="tabpanel"><span id="s2" data-lavish-ref="${ITEM}" data-lavish-field="status">draft</span></section>
${QUESTION("a")}
<script>
function show(){const id=(location.hash||"#t1").slice(1);for(const p of document.querySelectorAll("[role=tabpanel]"))p.classList.toggle("active",p.id===id);}
addEventListener("hashchange",show);show();
document.getElementById("aSend").addEventListener("click",()=>window.lavish.queuePrompt("merge? yes",{element:document.getElementById("aSend")}));
</script></body></html>`;

const boundPage = (title, rootAttrs = "", extraScript = "") =>
  `<!doctype html><html${rootAttrs}><head><title>${title}</title></head><body>
<span id="s1" data-lavish-ref="${ITEM}" data-lavish-field="status">draft</span>
${QUESTION("b")}
<script>${extraScript}</script></body></html>`;

test(
  "one store drives every page and tab live; the kill switch leaves a page stale",
  { skip: !runBrowserE2e, timeout: 180_000 },
  async () => {
    const chrome = await chromePath();
    assert.ok(chrome, "Chrome is installed");
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-shared-state-"));
    const pages = path.join(temp, "pages");
    const cliEnv = { LAVISH_AXI_STATE_DIR: path.join(temp, "cli-state"), LAVISH_AXI_TELEMETRY: "0" };
    /** @type {Record<string, string | undefined>} */
    const env = { ...process.env, LAVISH_AXI_HOST: "127.0.0.1", LAVISH_AXI_LINK_HOST: "127.0.0.1" };
    delete env.LAVISH_STATE;
    let server;
    let browser;
    try {
      await mkdir(pages);
      await writeFile(path.join(pages, "page-a.html"), PAGE_A);
      await writeFile(path.join(pages, "page-b.html"), boundPage("B"));
      await writeFile(path.join(pages, "page-c.html"), boundPage("C (state off)", ' data-lavish-state="off"'));
      await writeFile(
        path.join(pages, "page-d.html"),
        boundPage(
          "D",
          "",
          'document.addEventListener("DOMContentLoaded",()=>{window.__atDcl=document.getElementById("s1").textContent;});',
        ),
      );
      runCli(["state", "set", ITEM, "status=open", "--dir", pages, "--source", "github"], cliEnv);

      server = await serve({ env, port: 0, stateFile: path.join(temp, "server-state.json"), version: "9.9.9-test" });
      const base = `http://127.0.0.1:${server.port}`;
      const sessionUrl = async (name) => {
        const response = await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file: path.join(pages, name), no_gate: true }),
        });
        return (await response.json()).url;
      };

      browser = await launchChrome(chrome, path.join(temp, "chrome"));
      const pageA = await browser.openPage(await sessionUrl("page-a.html"));
      const pageB = await browser.openPage(await sessionUrl("page-b.html"));
      const pageC = await browser.openPage(await sessionUrl("page-c.html"));
      const ready = (value) => value === true;
      await pageA.waitFor("Boolean(window.lavish)", ready, "page A SDK booted");
      await pageB.waitFor("Boolean(window.lavish)", ready, "page B SDK booted");
      await pageC.waitFor("Boolean(window.lavish)", ready, "page C SDK booted");

      // First paint is current: the store's value replaced the baked "draft" on bound pages.
      await pageA.waitFor('document.getElementById("s1").textContent', (v) => v === "open", "A first paint");
      await pageB.waitFor('document.getElementById("s1").textContent', (v) => v === "open", "B first paint");
      assert.equal(await pageC.frameEval('document.getElementById("s1").textContent'), "draft");

      // Tab regression, in annotate mode (the default). A widget link to another URL still annotates.
      assert.equal(await pageA.frameEval('document.documentElement.getAttribute("data-lavish-annotate")'), null);
      await pageA.frameEval('document.getElementById("tabAway").click(), true');
      await delay(200);
      assert.equal(await pageA.frameEval("location.hash"), "", "an off-page widget link stays annotatable");
      await pageA.frameEval('document.getElementById("tab2").click(), true');
      await pageA.waitFor("location.hash", (v) => v === "#t2", "clicking a role=tab anchor changes the hash");
      await pageA.waitFor(
        'getComputedStyle(document.getElementById("t2")).display !== "none" && getComputedStyle(document.getElementById("t1")).display === "none"',
        ready,
        "the second tab panel is shown",
      );

      // Live update with no reload, reaching both tabs of A and page B; C (kill switch) stays stale.
      await pageA.frameEval("window.__noReload = 1, true");
      await pageB.frameEval("window.__noReload = 1, true");
      runCli(["state", "set", ITEM, "status=merged", "--dir", pages, "--source", "github"], cliEnv);
      await pageA.waitFor(
        '[document.getElementById("s1").textContent, document.getElementById("s2").textContent].join("|")',
        (v) => v === "merged|merged",
        "both tabs of A agree on the new status",
      );
      await pageB.waitFor('document.getElementById("s1").textContent', (v) => v === "merged", "B updates live");
      assert.equal(await pageA.frameEval("window.__noReload"), 1, "A was not reloaded");
      assert.equal(await pageB.frameEval("window.__noReload"), 1, "B was not reloaded");
      assert.equal(
        await pageA.frameEval(
          'document.getElementById("s2").closest("[data-lavish-ref]").getAttribute("data-lavish-status")',
        ),
        "merged",
      );
      await delay(1000);
      assert.equal(
        await pageC.frameEval('document.getElementById("s1").textContent'),
        "draft",
        "negative control: C is stale",
      );
      assert.equal(await pageC.frameEval('document.getElementById("s1").getAttribute("data-lavish-status")'), null);

      // Answering on A flips the same question on B; C keeps its controls.
      await pageA.frameEval('document.getElementById("aYes").click(), document.getElementById("aSend").click(), true');
      await pageB.waitFor(
        'document.getElementById("bYes").disabled && document.querySelector("[data-lavish-state-answer]")?.textContent',
        (v) => v === "✅ YOUR PICK: Yes",
        "B shows A's answer and disables its controls",
      );
      await pageA.waitFor('document.getElementById("aSend").disabled', ready, "A disables its own controls");
      assert.equal(
        await pageC.frameEval('document.getElementById("bYes").disabled'),
        false,
        "negative control: C stays open",
      );
      const stored = JSON.parse(await readFile(path.join(pages, ".lavish", "state.json"), "utf8"));
      assert.equal(stored.items["q:merge"].status, "answered");
      assert.equal(stored.items["q:merge"].answer, "Yes");
      assert.equal(stored.items["q:merge"].source, "page-a.html");
      assert.ok(stored.items["q:merge"].answeredAt);

      // A page opened later is current at DOMContentLoaded, before any live event can arrive.
      const pageD = await browser.openPage(await sessionUrl("page-d.html"));
      assert.equal(await pageD.waitFor("window.__atDcl", (v) => typeof v === "string", "D loaded"), "merged");
      await pageD.waitFor('document.getElementById("bYes").disabled', ready, "D starts with the question answered");
    } finally {
      await browser?.close();
      await server?.close();
      await rm(temp, { recursive: true, force: true });
    }
  },
);
