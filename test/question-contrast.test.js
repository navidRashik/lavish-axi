import assert from "node:assert/strict";
import test from "node:test";

import { lavishQuestionPalette } from "../src/question-visibility.js";

// WCAG 2.2 relative luminance and contrast ratio.
function rgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}
function luminance([r, g, b]) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function over([r, g, b, alpha], base) {
  return base.map((channel, index) => Math.round([r, g, b][index] * alpha + channel * (1 - alpha)));
}

// The pages the tint lays over: the Lavish house theme's card and page colours, and plain paper.
const PAGES = {
  light: { card: "#fbfbfc", bg: "#f4f5f7", fg: "#1f2329", paper: "#ffffff", ink: "#000000" },
  dark: { card: "#1e2126", bg: "#17191d", fg: "#e4e6ea", paper: "#000000", ink: "#ffffff" },
};
const TEXT_AA = 4.5;
const NON_TEXT_AA = 3;

for (const theme of ["light", "dark"]) {
  test(`question colours meet WCAG AA in the ${theme} theme`, () => {
    const p = lavishQuestionPalette()[theme];
    const page = PAGES[theme];
    const pairs = [
      ["YOUR CALL label text on its chip", p.labelFg, p.labelBg, TEXT_AA],
      ["bar text on the bar", p.barFg, p.barBg, TEXT_AA],
      ["jump link text on its chip", p.linkFg, p.linkBg, TEXT_AA],
      ["answered line text on its chip", p.mutedFg, p.mutedBg, TEXT_AA],
      ["bar focus ring against the bar", p.barFocus, p.barBg, NON_TEXT_AA],
    ];
    for (const base of [page.card, page.bg, page.paper]) {
      const tinted = over(p.tint, rgb(base));
      const hex = "#" + tinted.map((c) => c.toString(16).padStart(2, "0")).join("");
      pairs.push(
        [`page text on the card tint over ${base}`, base === page.paper ? page.ink : page.fg, hex, TEXT_AA],
        [`card border against the card tint over ${base}`, p.border, hex, NON_TEXT_AA],
        [`focus ring against the card tint over ${base}`, p.focus, hex, NON_TEXT_AA],
      );
    }
    for (const [name, fg, bg, minimum] of pairs) {
      const ratio = contrast(rgb(fg), rgb(bg));
      assert.ok(ratio >= minimum, `${theme}: ${name} is ${ratio.toFixed(2)}:1 (${fg} on ${bg}), below ${minimum}:1`);
    }
  });
}
