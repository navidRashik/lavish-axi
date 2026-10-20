import assert from "node:assert/strict";
import test from "node:test";

import { mermaidThemeFor } from "../src/markdown-theme.js";

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
