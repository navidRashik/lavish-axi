/* Lavish house Mermaid renderer. Canonical copy: ~/.config/opencode/lavish-house/.
   Copy it next to the artifact and load it as a classic script, not a module:
     <script src="house-mermaid.js"></script>   (end of <body>, after house.css)
   Lavish serves artifacts under a sandbox CSP (opaque origin), so a local
   `import "./x.mjs"` is refused by CORS; a classic <script src> is not.

   What it does:
   - themes every diagram from house.css custom properties (theme "base",
     system font, 16px), for light and dark, and re-renders when the scheme flips;
   - renders every .mermaid element as .house-diagram: plain SVG at natural size.
     Lavish turns rendered `.mermaid` SVGs into hand-drawn Excalidraw
     whiteboards; add class "whiteboard" (class="mermaid whiteboard") to opt in;
   - recolours role classDefs for the active scheme (fill/stroke/color replaced,
     other properties such as stroke-width kept), so pages never hard-code
     dark-mode colours:  problem, risk -> problem;  fix, rec, ok -> ok;
     ctx -> context (accent);  neutral -> neutral.
   - puts a full-screen button in the corner of every rendered house diagram. It
     opens a copy of the SVG fitted to the viewport (Fullscreen API when the
     sandbox allows it, a fixed overlay either way): drag pans, wheel or pinch
     zooms, +/−/Reset buttons, Esc, the close button or a backdrop click closes.
     The inline diagram stays exactly as rendered.
   API: window.houseMermaid = { init(mermaid, scheme), config(scheme), render() } */
(() => {
 "use strict";
 const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.esm.min.mjs";
 const FALLBACK_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
 const media = window.matchMedia("(prefers-color-scheme: dark)");
 const root = document.documentElement;
 const scheme = () => (media.matches ? "dark" : "light");

 function palette() {
  const css = getComputedStyle(root);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
   font: v("--font-sans", FALLBACK_FONT),
   card: v("--card", "#fbfbfc"),
   fg: v("--fg", "#1f2329"),
   mut: v("--mut", "#4f5967"),
   line: v("--line", "#d9dde3"),
   acc: v("--acc", "#2b5797"),
   node: v("--node", "#eef1f6"),
   nodeLine: v("--node-line", "#7d8ba0"),
   edge: v("--edge", "#5f6b7a"),
   cluster: v("--cluster", "#f3f5f8"),
   ok: v("--ok", "#0b6e8a"),
   okBg: v("--ok-bg", "#e2f0f4"),
   problem: v("--problem", "#c0254a"),
   problemBg: v("--problem-bg", "#fce8ec"),
   problemInk: v("--problem-ink", "#1f2329"),
  };
 }

 function config(activeScheme = scheme()) {
  const p = palette();
  return {
   startOnLoad: false,
   securityLevel: "strict",
   theme: "base",
   fontFamily: p.font,
   flowchart: { useMaxWidth: false, htmlLabels: true, nodeSpacing: 40, rankSpacing: 50 },
   sequence: { useMaxWidth: false },
   state: { useMaxWidth: false },
   class: { useMaxWidth: false },
   er: { useMaxWidth: false },
   themeVariables: {
    darkMode: activeScheme === "dark",
    fontFamily: p.font,
    fontSize: "16px",
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
    tertiaryBorderColor: p.line,
    nodeBorder: p.nodeLine,
    nodeTextColor: p.fg,
    textColor: p.fg,
    titleColor: p.fg,
    lineColor: p.edge,
    defaultLinkColor: p.edge,
    edgeLabelBackground: p.card,
    clusterBkg: p.cluster,
    clusterBorder: p.line,
    noteBkgColor: p.cluster,
    noteTextColor: p.fg,
    noteBorderColor: p.line,
   },
  };
 }

 function init(mermaid, activeScheme = scheme()) {
  mermaid.initialize(config(activeScheme));
 }

 function roleColours(p) {
  const problem = { fill: p.problemBg, stroke: p.problem, color: p.problemInk };
  const ok = { fill: p.okBg, stroke: p.ok, color: p.fg };
  return {
   problem, risk: problem,
   fix: ok, rec: ok, ok,
   ctx: { fill: p.node, stroke: p.acc, color: p.fg },
   neutral: { fill: p.cluster, stroke: p.nodeLine, color: p.fg },
  };
 }

 function themeSource(src) {
  const roles = roleColours(palette());
  return src.replace(/^([ \t]*classDef[ \t]+)([\w-]+)([ \t]+)(.*)$/gm, (line, lead, name, gap, props) => {
   const role = roles[name];
   if (!role) return line;
   const kept = props.split(",").map((s) => s.trim()).filter((s) => s && !/^(fill|stroke|color)\s*:/.test(s));
   const themed = [`fill:${role.fill}`, `stroke:${role.stroke}`, `color:${role.color}`, ...kept];
   return `${lead}${name}${gap}${themed.join(",")}`;
  });
 }

 /* ---- full-screen view ------------------------------------------------ */
 const EXPAND_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"' +
  ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>';
 const MIN_SCALE = 0.1;
 const MAX_SCALE = 12;
 const FIT_PADDING = 32;
 let fs; // overlay state, built on first open

 // Wraps the diagram once with a slim toolbar row ABOVE it, so the button
 // never covers any part of the drawing; re-renders only replace the
 // diagram's own content, so the frame, bar and button survive them.
 function addFullscreenButton(el) {
  const frame = document.createElement("div");
  frame.className = "house-diagram-frame";
  el.before(frame);
  const bar = document.createElement("div");
  bar.className = "house-diagram-bar";
  frame.append(bar, el);
  const button = document.createElement("button");
  button.type = "button"; // diagrams can sit inside forms
  button.className = "house-fs-open";
  button.title = "Full screen";
  button.setAttribute("aria-label", "Open diagram full screen");
  button.innerHTML = EXPAND_ICON + "<span>Full screen</span>";
  button.hidden = true;
  button.addEventListener("click", () => openFullscreen(el, button));
  bar.append(button);
  return button;
 }

 // A copy with every id suffixed (and every #id reference rewritten) so its
 // markers and scoped styles never resolve to the inline original.
 function copySvg(svg) {
  const copy = svg.cloneNode(true);
  const ids = new Map();
  for (const node of [copy, ...copy.querySelectorAll("[id]")]) {
   if (!node.id) continue;
   ids.set(node.id, `${node.id}-fs`);
   node.id += "-fs";
  }
  const rewrite = (text) => text.replace(/#([\w-]+)/g, (m, id) => (ids.has(id) ? `#${ids.get(id)}` : m));
  for (const node of [copy, ...copy.querySelectorAll("*")]) {
   for (const attr of node.attributes) if (attr.value.includes("#")) attr.value = rewrite(attr.value);
  }
  for (const style of copy.querySelectorAll("style")) style.textContent = rewrite(style.textContent);
  return copy;
 }

 function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "house-fs";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Diagram, full screen");
  overlay.innerHTML =
   '<div class="house-fs-shell">' +
   '<div class="house-fs-stage"><div class="house-fs-canvas"></div></div>' +
   '<div class="house-fs-tools" role="toolbar" aria-label="Diagram view">' +
   '<button type="button" data-fs="out" aria-label="Zoom out" title="Zoom out (−)">−</button>' +
   '<span class="house-fs-zoom" aria-live="polite">100%</span>' +
   '<button type="button" data-fs="in" aria-label="Zoom in" title="Zoom in (+)">+</button>' +
   '<button type="button" data-fs="reset" title="Fit to screen (0)">Reset</button>' +
   '<button type="button" data-fs="close" aria-label="Close full screen" title="Close (Esc)">×</button>' +
   "</div>" +
   '<p class="house-fs-hint">Drag to pan · scroll or pinch to zoom · Esc to close</p>' +
   "</div>";
  document.body.append(overlay);
  const state = {
   overlay,
   stage: overlay.querySelector(".house-fs-stage"),
   canvas: overlay.querySelector(".house-fs-canvas"),
   zoom: overlay.querySelector(".house-fs-zoom"),
   close: overlay.querySelector('[data-fs="close"]'),
   open: false,
   inFullscreen: false,
   fitted: true,
   pointers: new Map(),
   w: 0, h: 0, x: 0, y: 0, s: 1,
  };
  const { stage } = state;
  const local = (e) => {
   const r = stage.getBoundingClientRect();
   return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const centre = () => ({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 });

  stage.addEventListener("wheel", (e) => {
   e.preventDefault();
   const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
   const p = local(e);
   zoomAt(Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.002)), p.x, p.y);
  }, { passive: false });

  stage.addEventListener("pointerdown", (e) => {
   if (e.button !== 0) return;
   stage.setPointerCapture(e.pointerId);
   state.pointers.set(e.pointerId, local(e));
   stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", (e) => {
   if (!state.pointers.has(e.pointerId)) return;
   const before = [...state.pointers.values()];
   state.pointers.set(e.pointerId, local(e));
   const after = [...state.pointers.values()];
   if (after.length === 1) {
    pan(after[0].x - before[0].x, after[0].y - before[0].y);
    return;
   }
   // pinch: follow the midpoint of the first two pointers, scale by their spread
   const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
   const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
   const m0 = mid(before[0], before[1]);
   const m1 = mid(after[0], after[1]);
   pan(m1.x - m0.x, m1.y - m0.y);
   zoomAt(gap(after[0], after[1]) / gap(before[0], before[1]), m1.x, m1.y);
  });
  const release = (e) => {
   state.pointers.delete(e.pointerId);
   if (!state.pointers.size) stage.classList.remove("is-dragging");
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);

  overlay.addEventListener("click", (e) => {
   if (e.target === overlay) return closeFullscreen();
   const action = e.target.closest?.("[data-fs]")?.dataset.fs;
   const c = centre();
   if (action === "in") zoomAt(1.25, c.x, c.y);
   else if (action === "out") zoomAt(0.8, c.x, c.y);
   else if (action === "reset") fit();
   else if (action === "close") closeFullscreen();
  });

  document.addEventListener("keydown", (e) => {
   if (!state.open) return;
   const c = centre();
   if (e.key === "Escape") closeFullscreen();
   else if (e.key === "+" || e.key === "=") zoomAt(1.25, c.x, c.y);
   else if (e.key === "-" || e.key === "_") zoomAt(0.8, c.x, c.y);
   else if (e.key === "0") fit();
   else if (e.key === "Tab") {
    // keep focus inside the dialog
    const stops = [...overlay.querySelectorAll("button")];
    const i = stops.indexOf(document.activeElement);
    stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
   } else return;
   e.preventDefault();
  });

  // Esc in real fullscreen is taken by the browser; leaving it closes the view.
  document.addEventListener("fullscreenchange", () => {
   if (state.inFullscreen && document.fullscreenElement !== overlay) {
    state.inFullscreen = false;
    closeFullscreen();
   }
  });
  new ResizeObserver(() => {
   if (state.open && state.fitted) fit();
  }).observe(stage);
  return state;
 }

 function applyView() {
  fs.canvas.style.transform = `translate(${fs.x}px, ${fs.y}px) scale(${fs.s})`;
  fs.zoom.textContent = `${Math.round(fs.s * 100)}%`;
  fs.stage.dataset.scale = String(fs.s);
 }

 const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

 function fit() {
  const w = fs.stage.clientWidth;
  const h = fs.stage.clientHeight;
  fs.s = clampScale(Math.min((w - 2 * FIT_PADDING) / fs.w, (h - 2 * FIT_PADDING) / fs.h));
  fs.x = (w - fs.w * fs.s) / 2;
  fs.y = (h - fs.h * fs.s) / 2;
  fs.fitted = true;
  applyView();
 }

 function pan(dx, dy) {
  fs.x += dx;
  fs.y += dy;
  fs.fitted = false;
  applyView();
 }

 function zoomAt(factor, cx, cy) {
  const s = clampScale(fs.s * factor);
  fs.x = cx - (cx - fs.x) * (s / fs.s);
  fs.y = cy - (cy - fs.y) * (s / fs.s);
  fs.s = s;
  fs.fitted = false;
  applyView();
 }

 // Shows the source diagram's current SVG; true when there was one to show.
 function refreshCopy() {
  const svg = fs.source.querySelector("svg");
  if (!svg) return false;
  const box = svg.getBoundingClientRect();
  if (box.width && box.height) {
   fs.w = box.width;
   fs.h = box.height;
  }
  const copy = copySvg(svg);
  copy.style.width = `${fs.w}px`;
  copy.style.height = `${fs.h}px`;
  fs.canvas.replaceChildren(copy);
  return true;
 }

 function openFullscreen(el, trigger) {
  fs ||= buildOverlay();
  fs.source = el;
  fs.trigger = trigger;
  if (!refreshCopy()) return;
  fs.open = true;
  fs.overlay.hidden = false;
  root.classList.add("house-fs-active");
  fit();
  fs.close.focus({ preventScroll: true });
  // Lavish's sandboxed iframe may refuse this; the overlay already fills the viewport.
  if (document.fullscreenEnabled && fs.overlay.requestFullscreen) {
   fs.overlay.requestFullscreen().then(
    () => {
     if (fs.open) fs.inFullscreen = true;
     else document.exitFullscreen().catch(() => { });
    },
    () => { },
   );
  }
 }

 function closeFullscreen() {
  if (!fs?.open) return;
  fs.open = false;
  fs.overlay.hidden = true;
  fs.canvas.replaceChildren();
  fs.pointers.clear();
  fs.stage.classList.remove("is-dragging");
  root.classList.remove("house-fs-active");
  const restoreFocus = () => fs.trigger?.focus({ preventScroll: true });
  fs.inFullscreen = false;
  // Leaving real fullscreen resets focus, so hand it back once that settles.
  if (document.fullscreenElement === fs.overlay) document.exitFullscreen().then(restoreFocus, restoreFocus);
  else restoreFocus();
 }

 const decoder = document.createElement("textarea");
 const diagrams = [...document.querySelectorAll(".mermaid")].map((el) => {
  decoder.innerHTML = el.innerHTML; // keeps <br/> label breaks as source text
  const whiteboard = el.classList.contains("whiteboard");
  if (!whiteboard) el.classList.replace("mermaid", "house-diagram");
  // Whiteboards get Lavish's own full-screen action; house diagrams get ours.
  const button = whiteboard ? null : addFullscreenButton(el);
  return { el, html: el.innerHTML, src: decoder.value.trim(), whiteboard, button };
 });

 let mermaidModule;
 let seq = 0;
 let queue = Promise.resolve();

 async function renderAll() {
  if (!diagrams.length) return;
  root.classList.add("house-pending");
  try {
   mermaidModule ||= (await import(MERMAID_URL)).default;
   await document.fonts?.ready;
   init(mermaidModule);
   for (const d of diagrams) {
    if (d.whiteboard) {
     d.el.removeAttribute("data-processed");
     d.el.innerHTML = d.html;
     await mermaidModule.run({ nodes: [d.el] });
     continue;
    }
    const id = `house-diagram-${++seq}`;
    try {
     const { svg, bindFunctions } = await mermaidModule.render(id, themeSource(d.src));
     d.el.innerHTML = svg;
     // Without this Lavish treats the SVG as Mermaid and swaps it for a whiteboard.
     d.el.querySelector("svg")?.removeAttribute("aria-roledescription");
     bindFunctions?.(d.el);
    } catch (error) {
     document.getElementById(`d${id}`)?.remove();
     d.el.textContent = d.src;
     console.error("house-mermaid: diagram failed to render", error);
    }
   }
  } catch (error) {
   for (const d of diagrams) if (!d.el.querySelector("svg")) d.el.textContent = d.src;
   console.error("house-mermaid: Mermaid failed to load", error);
  } finally {
   for (const d of diagrams) if (d.button) d.button.hidden = !d.el.querySelector("svg");
   if (fs?.open) refreshCopy();
   root.classList.remove("house-pending");
  }
 }

 function render() {
  queue = queue.then(renderAll);
  return queue;
 }

 window.houseMermaid = { init, config, render };
 media.addEventListener("change", render);
 render();
})();
