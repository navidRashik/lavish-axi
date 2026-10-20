// Picks the mermaid theme for a diagram from the surface it is drawn on. Pure: the browser entry
// reads the computed colours and passes them in as [r, g, b, a] bytes.

/**
 * `top` painted over `bottom`, both [r, g, b, a] bytes.
 * @param {number[]} top
 * @param {number[]} bottom
 */
function composite(top, bottom) {
  const ta = top[3] / 255;
  const ba = bottom[3] / 255;
  const alpha = ta + ba * (1 - ta);
  if (alpha === 0) return [0, 0, 0, 0];
  const channel = (/** @type {number} */ i) => (top[i] * ta + bottom[i] * ba * (1 - ta)) / alpha;
  return [channel(0), channel(1), channel(2), alpha * 255];
}

/**
 * The mermaid theme for a diagram. The painted backgrounds from the diagram up to the root decide,
 * composited bottom-up, so a host page's own CSS, data-theme, theme classes and prefers-color-scheme
 * rules all count. Only a fully unpainted chain falls back to the root's color-scheme, then the OS.
 * @param {{ backgrounds: number[][], colorScheme: string, prefersDark: boolean }} surface
 *   backgrounds: [r, g, b, a] of the diagram and each ancestor, innermost first
 * @returns {"dark" | "default"}
 */
export function mermaidThemeFor({ backgrounds, colorScheme, prefersDark }) {
  const layers = [];
  for (const rgba of backgrounds) {
    if (rgba[3] === 0) continue;
    layers.push(rgba);
    if (rgba[3] === 255) break;
  }
  const [r, g, b, a] = layers.reduceRight((under, over) => composite(over, under), [0, 0, 0, 0]);
  let dark = prefersDark;
  if (a > 0) dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  else if (colorScheme.includes("dark") !== colorScheme.includes("light")) dark = colorScheme.includes("dark");
  return dark ? "dark" : "default";
}
