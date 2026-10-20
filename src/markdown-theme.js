// Picks the mermaid theme for a diagram from the surface it is drawn on, and the mermaid
// configuration for that theme. Pure: the browser entry reads the computed colours and passes them
// in as [r, g, b, a] bytes.

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

// The Lavish house palette (house.css tokens) for each surface tone.
const HOUSE = {
  default: {
    card: "#fbfbfc",
    fg: "#1f2329",
    node: "#eef1f6",
    nodeLine: "#7d8ba0",
    edge: "#5f6b7a",
    cluster: "#f3f5f8",
  },
  dark: {
    card: "#1e2126",
    fg: "#e4e6ea",
    node: "#272c34",
    nodeLine: "#76839a",
    edge: "#97a1ae",
    cluster: "#22262c",
  },
};

/**
 * Mermaid configuration for a diagram on a surface of the given tone: mermaid's `base` theme with
 * every colour pinned to a house token, so no text falls below 4.5:1 against what is behind it and
 * no line or arrow below 3:1. Mermaid derives any colour left unset by lightening or darkening
 * another, which is how lifelines and edge labels lose contrast, so the sequence and label colours
 * are set explicitly.
 * @param {"dark" | "default"} theme
 */
export function mermaidConfigFor(theme) {
  const p = HOUSE[theme];
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    // Natural size, not shrunk to the column: a wide flowchart scrolls instead of becoming unreadable.
    flowchart: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
    themeVariables: {
      darkMode: theme === "dark",
      background: p.card,
      mainBkg: p.node,
      primaryColor: p.node,
      primaryTextColor: p.fg,
      primaryBorderColor: p.nodeLine,
      secondaryColor: p.cluster,
      secondaryTextColor: p.fg,
      secondaryBorderColor: p.nodeLine,
      tertiaryColor: p.card,
      tertiaryTextColor: p.fg,
      tertiaryBorderColor: p.nodeLine,
      nodeBorder: p.nodeLine,
      nodeTextColor: p.fg,
      textColor: p.fg,
      titleColor: p.fg,
      lineColor: p.edge,
      defaultLinkColor: p.edge,
      edgeLabelBackground: p.card,
      clusterBkg: p.cluster,
      clusterBorder: p.nodeLine,
      noteBkgColor: p.cluster,
      noteTextColor: p.fg,
      noteBorderColor: p.nodeLine,
      actorBkg: p.node,
      actorBorder: p.nodeLine,
      actorTextColor: p.fg,
      actorLineColor: p.edge,
      signalColor: p.edge,
      signalTextColor: p.fg,
      labelBoxBkgColor: p.node,
      labelBoxBorderColor: p.nodeLine,
      labelTextColor: p.fg,
      loopTextColor: p.fg,
      activationBkgColor: p.cluster,
      activationBorderColor: p.nodeLine,
      sequenceNumberColor: p.card,
    },
  };
}
