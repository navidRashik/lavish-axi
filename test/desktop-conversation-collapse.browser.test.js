import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The desktop conversation panel folds into a rail so the artifact can take the width. Before this
// change nothing above 860px could hide the panel: the chevron existed only for the phone sheet.
// These assertions are what a reviewer at 1440x900 would notice: the control is there, the
// artifact really widens, the choice survives a reload, a reply is not missed while folded, a
// note still reaches `lavish-axi poll`, and crossing the phone breakpoint leaves no stray state.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Collapse fixture</title>
<style>body{margin:0;padding:24px;font-family:Georgia,serif}</style>
</head><body><h1>Checkout redesign</h1><p>Review the order before paying.</p></body></html>`;

const GEOMETRY = `() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }; };
  const toggle = document.getElementById("panelToggle");
  const summary = document.getElementById("panelSummary");
  return JSON.stringify({
    viewport: innerWidth,
    collapsed: document.body.classList.contains("panel-collapsed"),
    sheetOpen: document.body.classList.contains("sheet-open"),
    panel: rect(document.getElementById("panel")),
    frame: rect(document.getElementById("artifact")),
    toggle: rect(toggle),
    expanded: toggle.getAttribute("aria-expanded"),
    label: toggle.getAttribute("aria-label"),
    chatVisible: document.getElementById("panelScroll").getClientRects().length > 0,
    summary: getComputedStyle(summary).display === "none" ? null : summary.textContent,
    unread: summary.classList.contains("is-unread"),
    stored: localStorage.getItem("lavish-axi:panel-collapsed"),
  });
}`;

test(
  "the desktop conversation panel folds into a rail and back",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-desktop-collapse-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-desktop-collapse-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], chromeEnv);
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }

    function wait(ms) {
      run("chrome-devtools-axi", ["wait", String(ms)], chromeEnv, ms + 45_000);
    }

    function open(url, settleMs = 4000) {
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      wait(settleMs);
    }

    function act(expression) {
      evaluate(`() => { ${expression}; return "ok"; }`);
      wait(400);
      return evaluate(GEOMETRY);
    }

    function assertExpanded(g) {
      assert.equal(g.collapsed, false);
      assert.equal(g.expanded, "true");
      assert.equal(g.label, "Hide conversation");
      assert.ok(g.toggle.width > 0 && g.toggle.height > 0, `the toggle is visible on desktop: ${JSON.stringify(g)}`);
      assert.equal(g.panel.width, 360, "the panel keeps its width");
      assert.equal(g.frame.right, g.panel.left, "artifact and panel sit side by side");
      assert.equal(g.chatVisible, true);
      assert.equal(g.stored, null);
    }

    function assertCollapsed(g) {
      assert.equal(g.collapsed, true);
      assert.equal(g.sheetOpen, false);
      assert.equal(g.expanded, "false");
      assert.equal(g.label, "Show conversation");
      assert.ok(g.toggle.width > 0, `the reopen control stays on the rail: ${JSON.stringify(g)}`);
      assert.equal(g.panel.width, 44, "the panel is a narrow rail");
      assert.equal(g.frame.left, 0);
      assert.equal(g.frame.width, g.viewport - g.panel.width, "the artifact takes every pixel the rail does not");
      assert.equal(g.chatVisible, false);
      assert.ok(g.summary, "the rail keeps the dock summary");
      assert.equal(g.stored, "1");
    }

    try {
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);

      // Newer drivers emulate only on a selected page, so open once before fixing the viewport.
      open(url, 1000);
      run("chrome-devtools-axi", ["emulate", "--viewport", "1440x900x1"], chromeEnv);
      open(url);
      assertExpanded(evaluate(GEOMETRY));

      // A click on the chevron folds the panel and the choice survives a chrome reload.
      assertCollapsed(act('document.getElementById("panelToggle").click()'));
      open(url, 3000);
      assertCollapsed(evaluate(GEOMETRY));

      // A reply that lands while folded is previewed on the rail rather than arriving unseen.
      run(
        process.execPath,
        ["bin/lavish-axi.js", "poll", artifact, "--agent-reply", "Renamed the payment step.", "--timeout-ms", "200"],
        lavishEnv,
        30_000,
      );
      wait(800);
      let g = evaluate(GEOMETRY);
      assertCollapsed(g);
      assert.equal(g.summary, "Renamed the payment step.");
      assert.equal(g.unread, true);

      // A note sent while folded still reaches the agent's poll.
      act(`const input = document.getElementById("chatInput");
        input.value = "Keep guest checkout";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("send").click()`);
      const feedback = run(
        process.execPath,
        ["bin/lavish-axi.js", "poll", artifact, "--timeout-ms", "20000"],
        lavishEnv,
        65_000,
      );
      assert.match(feedback, /Keep guest checkout/);
      assertCollapsed(evaluate(GEOMETRY));

      // Cmd/Ctrl+\ toggles it from the chrome.
      assertExpanded(
        act('document.dispatchEvent(new KeyboardEvent("keydown", { key: "\\\\", ctrlKey: true, bubbles: true }))'),
      );
      assertCollapsed(
        act('document.dispatchEvent(new KeyboardEvent("keydown", { key: "\\\\", metaKey: true, bubbles: true }))'),
      );

      // Narrowing to a phone hands the panel to the sheet with no rail left over, and widening
      // again restores the reviewer's desktop choice.
      run("chrome-devtools-axi", ["emulate", "--viewport", "800x900x1"], chromeEnv);
      wait(600);
      g = evaluate(GEOMETRY);
      assert.equal(g.collapsed, false);
      assert.equal(g.sheetOpen, false);
      assert.equal(g.label, "Show conversation");
      run("chrome-devtools-axi", ["emulate", "--viewport", "1440x900x1"], chromeEnv);
      wait(600);
      assertCollapsed(evaluate(GEOMETRY));

      // A click anywhere on the rail reopens it, and that choice survives a reload too.
      assertExpanded(act('document.getElementById("panelHead").querySelector("h2").parentElement.click()'));
      open(url, 3000);
      assertExpanded(evaluate(GEOMETRY));
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
