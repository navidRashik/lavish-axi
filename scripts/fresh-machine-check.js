// Black-box check of one agent-made Lavish page, through headless Chrome and the Lavish server:
//   - the reviewer sees the conversation panel open, with Send and End
//   - the artifact uses the house theme and has a sticky top navbar
//   - a real click on the page's question control reaches the server: the session's feedback
//     (GET /api/poll) carries that question's id and the chosen answer
//   - every navbar link works: in-page anchors name an element on the page, and each link to
//     another page loads with HTTP 200 and the title of a sibling page the agent wrote
// Exits 0 when every check passes, 1 when any fails, 2 on a setup failure or timeout.
//
//   node scripts/fresh-machine-check.js <session-url> <page-file> <screenshot.png>
//
// Chrome comes from $CHROME_BIN, else the usual install paths. Talks CDP over Node's WebSocket.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [url, pageFile, shot] = process.argv.slice(2);
if (!url || !pageFile || !shot) {
  console.error("usage: node scripts/fresh-machine-check.js <session-url> <page-file> <screenshot.png>");
  process.exit(2);
}

const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));
if (!chrome) {
  console.error("no Chrome found; set CHROME_BIN");
  process.exit(2);
}

const titleOf = (html) => /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1].trim() ?? "";
const pageDir = path.dirname(path.resolve(pageFile));
const siblingTitles = readdirSync(pageDir)
  .filter((name) => name.endsWith(".html") && path.join(pageDir, name) !== path.resolve(pageFile))
  .map((name) => titleOf(readFileSync(path.join(pageDir, name), "utf8")))
  .filter(Boolean);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (name) => console.error(`step ${name}`);

const profile = mkdtempSync(path.join(tmpdir(), "lavish-check-"));
const browser = spawn(chrome, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--window-size=1440,900",
]);
const browserExited = new Promise((resolve) => browser.once("exit", resolve));
const shutdown = async (code) => {
  socket?.close();
  browser.kill();
  await browserExited;
  rmSync(profile, { recursive: true, force: true });
  process.exit(code);
};
const overall = setTimeout(() => {
  console.error("TIMEOUT: the check did not finish in 120 s");
  void shutdown(2);
}, 120_000);

let socket;
const pending = new Map();
const contexts = [];
// Chrome may run the sandboxed artifact iframe in its own process; it then arrives as an
// auto-attached "iframe" target with its own session instead of a context in the page.
const iframeSessions = new Map();
// HTTP status of each tab's top-level document, keyed by CDP session; a tab's main frame id is
// its target id, which keeps iframe documents loaded in the same process from overwriting it.
const documentStatus = new Map();
const tabTargets = new Map();
let nextId = 0;

try {
  const wsUrl = await new Promise((resolve, reject) => {
    let err = "";
    browser.stderr.on("data", (chunk) => {
      err += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (match) resolve(match[1]);
    });
    browser.once("exit", () => reject(new Error(`Chrome exited: ${err}`)));
  });
  socket = new WebSocket(wsUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
} catch (error) {
  console.error(`SETUP FAIL: ${error.message}`);
  await shutdown(2);
}

socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  } else if (message.method === "Runtime.executionContextCreated") {
    contexts.push(message.params.context);
  } else if (message.method === "Target.attachedToTarget" && message.params.targetInfo.type === "iframe") {
    iframeSessions.set(message.params.targetInfo.targetId, message.params.sessionId);
  } else if (
    message.method === "Network.responseReceived" &&
    message.params.type === "Document" &&
    message.params.frameId === tabTargets.get(message.sessionId)
  ) {
    documentStatus.set(message.sessionId, message.params.response.status);
  }
});

/** One CDP call; a call Chrome never answers fails after 15 s instead of hanging the check. */
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} got no answer in 15 s`));
    }, 15_000);
    pending.set(id, {
      resolve: (value) => (clearTimeout(timer), resolve(value)),
      reject: (error) => (clearTimeout(timer), reject(error)),
    });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
const evaluate = async (expression, target) => {
  const { result, exceptionDetails } = await send(
    "Runtime.evaluate",
    { expression, contextId: target.contextId, returnByValue: true, awaitPromise: true },
    target.sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
};
const openTab = async (tabUrl) => {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  tabTargets.set(sessionId, targetId);
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await send("Page.navigate", { url: tabUrl }, sessionId);
  return sessionId;
};
const click = async (sessionId, x, y) => {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId);
  }
};

const checks = {};
let exitCode;
try {
  step("open session");
  const sessionId = await openTab(url);
  await wait(10_000);
  const top = { sessionId };

  step("find artifact frame");
  const { targetInfos } = await send("Target.getTargets");
  const iframeTarget = targetInfos.find((info) => iframeSessions.has(info.targetId) && info.url.includes("/artifact/"));
  const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
  const artifactFrame = (frameTree.childFrames || []).find((child) => child.frame.url.includes("/artifact/"));
  const sameProcessContext = artifactFrame
    ? contexts.findLast((context) => context.auxData?.frameId === artifactFrame.frame.id && context.auxData?.isDefault)
    : null;
  const artifact = iframeTarget
    ? { sessionId: iframeSessions.get(iframeTarget.targetId) }
    : sameProcessContext && { sessionId, contextId: sameProcessContext.id };
  if (!artifact) throw new Error("the session shows no artifact frame");
  const artifactUrl = iframeTarget ? iframeTarget.url : artifactFrame.frame.url;

  step("chrome and artifact state");
  Object.assign(
    checks,
    await evaluate(
      `(() => {
        const visible = (el) => Boolean(el && el.offsetParent);
        return {
          panelOpen: document.getElementById("panelToggle")?.getAttribute("aria-expanded") === "true",
          sendButton: visible(document.getElementById("send")),
          endButton: visible(document.getElementById("end")),
        };
      })()`,
      top,
    ),
  );
  const page = await evaluate(
    `(() => {
      const nav = document.querySelector("nav.house-nav");
      return {
        houseTheme: getComputedStyle(document.documentElement).getPropertyValue("--card").trim() !== "" &&
          [...document.styleSheets].some((sheet) => /house\\.css/.test(sheet.href || "")),
        navbar: Boolean(nav && nav.getClientRects().length && getComputedStyle(nav).position === "sticky"),
        links: nav ? [...nav.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")) : [],
        anchorsResolve: nav ? [...nav.querySelectorAll('a[href^="#"]')].every((a) =>
          a.getAttribute("href") === "#" || document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)))) : false,
      };
    })()`,
    artifact,
  );
  checks.houseTheme = page.houseTheme;
  checks.navbar = page.navbar;
  checks.navAnchorsResolve = page.anchorsResolve;
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(shot, Buffer.from(data, "base64"));

  step("click the question control");
  // Picks the last option so the answer differs from any preselected default, then presses the
  // question's submit control (or the option itself when options are buttons).
  const target = await evaluate(
    `(() => {
      const q = document.querySelector("[data-lavish-question]");
      if (!q) return null;
      q.scrollIntoView({ block: "center" });
      const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const options = [...q.querySelectorAll("input[type=radio], input[type=checkbox]")];
      const option = options.at(-1);
      const optionTarget = option && (option.closest("label") || (option.id && q.querySelector('label[for="' + option.id + '"]')) || option);
      const buttons = [...q.querySelectorAll("button, input[type=submit]")].filter((b) => b.getClientRects().length);
      const submit = option ? buttons.find((b) => b.type === "submit") || buttons.at(-1) : buttons.at(-1);
      if (!submit) return null;
      const answer = option ? option.value : submit.value || submit.dataset.answer || submit.textContent.trim();
      return {
        id: q.getAttribute("data-lavish-question") || q.id || "",
        answer,
        option: optionTarget ? center(optionTarget) : null,
        submit: center(submit),
      };
    })()`,
    artifact,
  );
  if (target) {
    const frameBox = await evaluate(
      `(() => { const f = [...document.querySelectorAll("iframe")].find((el) => el.src.includes("/artifact/"));
        const r = f.getBoundingClientRect(); return { x: r.left + f.clientLeft, y: r.top + f.clientTop }; })()`,
      top,
    );
    if (target.option) await click(sessionId, frameBox.x + target.option.x, frameBox.y + target.option.y);
    await wait(300);
    await click(sessionId, frameBox.x + target.submit.x, frameBox.y + target.submit.y);
    step("read the session feedback from the server");
    const origin = new URL(url).origin;
    const response = await fetch(
      `${origin}/api/poll?file=${encodeURIComponent(path.resolve(pageFile))}&timeoutMs=8000`,
    );
    const feedback = response.ok ? await response.json() : {};
    // Only the prompt items count: the feedback's dom_snapshot repeats the page text, so the
    // question's words appear there whether or not a prompt was ever sent.
    const prompts = JSON.stringify(Array.isArray(feedback.prompts) ? feedback.prompts : []);
    console.error(`prompts ${prompts.slice(0, 600)}`);
    checks.questionReachesServer =
      target.id !== "" && target.answer !== "" && prompts.includes(target.id) && prompts.includes(target.answer);
    console.log(`question id=${JSON.stringify(target.id)} answer=${JSON.stringify(target.answer)}`);
  } else {
    checks.questionReachesServer = false;
  }

  step("follow navbar links to other pages");
  const external = page.links.filter((href) => !href.startsWith("#"));
  checks.navLinksOtherPages = external.length > 0 && siblingTitles.length > 0;
  for (const href of external) {
    const linkUrl = new URL(href, artifactUrl).href;
    const tab = await openTab(linkUrl);
    await wait(5000);
    const status = documentStatus.get(tab);
    const title = await evaluate("document.title", { sessionId: tab });
    const ok =
      status === 200 && siblingTitles.some((expected) => title === expected || title.startsWith(`${expected} · `));
    console.log(`nav ${href} -> ${status} ${JSON.stringify(title)} ${ok ? "ok" : "BAD"}`);
    if (!ok) checks.navLinksOtherPages = false;
  }

  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
  console.log(exitCode === 0 ? "RESULT PASS" : "RESULT FAIL");
} catch (error) {
  console.log(`SETUP FAIL: ${error.message}`);
  exitCode = 2;
}
clearTimeout(overall);
await shutdown(exitCode);
