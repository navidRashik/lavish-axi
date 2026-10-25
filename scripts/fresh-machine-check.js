// Opens a Lavish session URL in headless Chrome and checks what a reviewer sees: the house
// theme applied to the artifact, its top navbar, a clickable question control, and the
// conversation panel open beside it with Send and End. Exits 1 when any check fails.
//
//   node scripts/fresh-machine-check.js <session-url> <screenshot.png>
//
// Chrome comes from $CHROME_BIN, else the usual install paths. Talks CDP over Node's WebSocket.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [url, shot] = process.argv.slice(2);
if (!url || !shot) {
  console.error("usage: node scripts/fresh-machine-check.js <session-url> <screenshot.png>");
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

const profile = mkdtempSync(path.join(tmpdir(), "lavish-check-"));
const browser = spawn(chrome, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--window-size=1440,900",
]);
const wsUrl = await new Promise((resolve, reject) => {
  let err = "";
  browser.stderr.on("data", (chunk) => {
    err += chunk;
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(err);
    if (match) resolve(match[1]);
  });
  browser.on("exit", () => reject(new Error(`Chrome exited: ${err}`)));
});

const socket = new WebSocket(wsUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let nextId = 0;
const pending = new Map();
const contexts = [];
// Chrome may run the sandboxed artifact iframe in its own process; it then arrives as an
// auto-attached "iframe" target with its own session instead of a context in the page.
const iframeSessions = new Map();
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
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let exitCode;
try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  await wait(10000);

  const evaluate = async (expression, target = { sessionId }) =>
    (await send("Runtime.evaluate", { expression, contextId: target.contextId, returnByValue: true }, target.sessionId))
      .result.value;
  const { targetInfos } = await send("Target.getTargets");
  const iframeTarget = targetInfos.find((info) => iframeSessions.has(info.targetId) && info.url.includes("/artifact/"));
  const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
  const artifactFrame = (frameTree.childFrames || []).find((child) => child.frame.url.includes("/artifact/"));
  const sameProcessContext = artifactFrame
    ? contexts.findLast((context) => context.auxData?.frameId === artifactFrame.frame.id && context.auxData?.isDefault)
    : null;
  const artifactTarget = iframeTarget
    ? { sessionId: iframeSessions.get(iframeTarget.targetId) }
    : sameProcessContext && { sessionId, contextId: sameProcessContext.id };

  const chromeState = await evaluate(`(() => {
    const visible = (el) => Boolean(el && el.offsetParent);
    return {
      panelOpen: document.getElementById("panelToggle")?.getAttribute("aria-expanded") === "true",
      sendButton: visible(document.getElementById("send")),
      endButton: visible(document.getElementById("end")),
    };
  })()`);
  const artifactState = artifactTarget
    ? await evaluate(
        `(() => {
          const visible = (el) => Boolean(el && el.getClientRects().length);
          const nav = document.querySelector("nav.house-nav");
          const questions = [...document.querySelectorAll("[data-lavish-question]")];
          return {
            houseTheme: getComputedStyle(document.documentElement).getPropertyValue("--card").trim() !== "" &&
              [...document.styleSheets].some((sheet) => /house\\.css/.test(sheet.href || "")),
            navbar: visible(nav) && nav.querySelectorAll("a[href]").length >= 2 && getComputedStyle(nav).position === "sticky",
            questionControl: questions.some((q) => [...q.querySelectorAll("button, input[type=submit]")].some(visible)),
          };
        })()`,
        artifactTarget,
      )
    : { houseTheme: false, navbar: false, questionControl: false };

  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(shot, Buffer.from(data, "base64"));

  const checks = { ...chromeState, ...artifactState };
  for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
  console.log(exitCode === 0 ? "RESULT PASS" : "RESULT FAIL");
} finally {
  socket.close();
  const exited = new Promise((resolve) => browser.once("exit", resolve));
  browser.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true });
}
process.exit(exitCode);
