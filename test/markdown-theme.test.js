import assert from "node:assert/strict";
import test from "node:test";

import { mermaidConfigFor, mermaidThemeFor } from "../src/markdown-theme.js";

const WHITE = [255, 255, 255, 255];
const NEAR_BLACK = [13, 17, 23, 255];
const CLEAR = [0, 0, 0, 0];

test("a painted light page draws light diagrams even when the OS prefers dark", () => {
  assert.equal(
    mermaidThemeFor({ backgrounds: [CLEAR, CLEAR, WHITE], colorScheme: "normal", prefersDark: true }),
    "default",
  );
});

test("a painted dark page draws dark diagrams even when the OS prefers light", () => {
  assert.equal(
    mermaidThemeFor({ backgrounds: [CLEAR, NEAR_BLACK], colorScheme: "normal", prefersDark: false }),
    "dark",
  );
});

test("the innermost opaque surface wins over the page behind it", () => {
  assert.equal(
    mermaidThemeFor({ backgrounds: [CLEAR, NEAR_BLACK, WHITE], colorScheme: "light", prefersDark: false }),
    "dark",
  );
  assert.equal(
    mermaidThemeFor({ backgrounds: [WHITE, NEAR_BLACK], colorScheme: "dark", prefersDark: true }),
    "default",
  );
});

test("a translucent layer is composited over the surface beneath it", () => {
  const darkTint = [0, 0, 0, 230];
  const lightTint = [0, 0, 0, 25];
  assert.equal(mermaidThemeFor({ backgrounds: [darkTint, WHITE], colorScheme: "normal", prefersDark: false }), "dark");
  assert.equal(
    mermaidThemeFor({ backgrounds: [lightTint, WHITE], colorScheme: "normal", prefersDark: true }),
    "default",
  );
});

test("an unpainted page follows a one-sided color-scheme, then the OS preference", () => {
  const unpainted = [CLEAR, CLEAR];
  assert.equal(mermaidThemeFor({ backgrounds: unpainted, colorScheme: "dark", prefersDark: false }), "dark");
  assert.equal(mermaidThemeFor({ backgrounds: unpainted, colorScheme: "light", prefersDark: true }), "default");
  assert.equal(mermaidThemeFor({ backgrounds: unpainted, colorScheme: "light dark", prefersDark: true }), "dark");
  assert.equal(mermaidThemeFor({ backgrounds: unpainted, colorScheme: "normal", prefersDark: false }), "default");
});

/** @param {string} hex */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(/** @type {string} */ a, /** @type {string} */ b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Page surfaces each tone is drawn on: the /md page shell and the house page background.
const SURFACES = { default: ["#ffffff", "#f4f5f7"], dark: ["#0d1117", "#17191d"] };

for (const theme of /** @type {const} */ (["default", "dark"])) {
  test(`${theme} mermaid colours keep text at 4.5:1 and lines at 3:1 against what is behind them`, () => {
    const config = mermaidConfigFor(theme);
    assert.equal(config.theme, "base", "only the base theme takes every colour from themeVariables");
    const v = config.themeVariables;
    /** @type {[string, string, string, number][]} */
    const pairs = [
      ["node label", v.nodeTextColor, v.mainBkg, 4.5],
      ["edge label", v.textColor, v.edgeLabelBackground, 4.5],
      ["actor text", v.actorTextColor, v.actorBkg, 4.5],
      ["note text", v.noteTextColor, v.noteBkgColor, 4.5],
      ["loop label box text", v.labelTextColor, v.labelBoxBkgColor, 4.5],
      ["sequence number", v.sequenceNumberColor, v.signalColor, 4.5],
      ["node border on node", v.nodeBorder, v.mainBkg, 3],
    ];
    for (const surface of SURFACES[theme]) {
      pairs.push(
        ["message text", v.signalTextColor, surface, 4.5],
        ["loop text", v.loopTextColor, surface, 4.5],
        ["flowchart edge", v.lineColor, surface, 3],
        ["sequence lifeline", v.actorLineColor, surface, 3],
        ["sequence message line", v.signalColor, surface, 3],
        ["node border", v.nodeBorder, surface, 3],
      );
    }
    for (const [what, fg, bg, min] of pairs) {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= min, `${what}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
    }
  });
}
