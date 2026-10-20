// Lavish helpers for tabbed pages. Load it at the end of <body>, after every marked block and
// before the tab script, which must keep panels as id="tab-<key>" and switch on hashchange to #<key>.
//
// 1. Keeps the reader's place (URL hash = open tab, and scrollY) across Lavish live reloads.
//    Lavish reloads the artifact by resetting the sandboxed iframe's src without its hash, and the
//    sandbox gives the page an opaque origin, so sessionStorage/localStorage throw. window.name
//    belongs to the iframe's browsing context and survives that src reset, so the state lives there.
// 2. Lavish lists only the first 6 entries of the data-lavish-revisions registry (one per palette
//    colour), so the list is narrowed in the page, before Lavish reads it at DOMContentLoaded, to the
//    6 newest entries that have a marked block. The saved file is unchanged.
// 3. Lavish's Revisions "Reveal" calls scrollIntoView({block, inline: "center", behavior: "smooth"})
//    and then places its flash marker from getBoundingClientRect() at once. A block in a hidden tab
//    is off-screen, and a smooth scroll has not moved yet when the rect is read, so the flash lands
//    in the wrong place. That call shape opens the block's tab first and scrolls instantly.
(() => {
  const TAG = "lavish-keep:";
  const LAVISH_REVISION_ROWS = 6;
  const path = location.pathname;
  const root = document.documentElement;

  const registry = document.querySelector("script[data-lavish-revisions]");
  if (registry) {
    try {
      const entries = JSON.parse(registry.textContent);
      const marked = new Set(
        [...document.querySelectorAll("[data-lavish-revision]")].map((el) => el.getAttribute("data-lavish-revision")),
      );
      const shown = entries.filter((entry) => entry && marked.has(String(entry.id))).slice(-LAVISH_REVISION_ROWS);
      if (shown.length !== entries.length) registry.textContent = JSON.stringify(shown);
    } catch {}
  }

  let saved = null;
  try {
    if (window.name.startsWith(TAG)) {
      const s = JSON.parse(window.name.slice(TAG.length));
      if (s && s.path === path) saved = s;
    }
  } catch {}

  if (saved && saved.hash && !location.hash) {
    try {
      history.replaceState(history.state, "", saved.hash);
    } catch {
      location.hash = saved.hash;
    }
  }

  let restoring = Boolean(saved && saved.y > 0);
  const save = () => {
    if (restoring) return;
    try {
      window.name = TAG + JSON.stringify({ path, hash: location.hash, y: Math.round(window.scrollY) });
    } catch {}
  };
  const stop = () => {
    if (!restoring) return;
    restoring = false;
    root.style.overflowAnchor = "";
    save();
  };
  let frame = 0;
  window.addEventListener("scroll", () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      save();
    });
  }, { passive: true });
  window.addEventListener("hashchange", save);

  const nativeScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (options) {
    const reveal =
      options && typeof options === "object" && options.block === "center" && options.inline === "center" &&
      options.behavior === "smooth";
    if (!reveal) return nativeScrollIntoView.apply(this, arguments);
    stop();
    const panel = this.closest('[id^="tab-"]');
    const key = panel && panel.id.slice(4);
    if (key && decodeURIComponent(location.hash.slice(1)) !== key) {
      try {
        history.replaceState(history.state, "", "#" + key);
      } catch {}
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    return nativeScrollIntoView.call(this, { block: "center", inline: "center", behavior: "instant" });
  };

  if (!restoring) return save();

  // Diagrams render after load (house-mermaid marks <html class="house-pending"> meanwhile), so the
  // page keeps growing above the reader. Hold the saved offset with scroll anchoring off until
  // layout has settled, the reader takes over, or the budget runs out.
  const target = saved.y;
  root.style.overflowAnchor = "none";
  for (const type of ["wheel", "touchstart", "keydown", "mousedown"]) {
    window.addEventListener(type, stop, { once: true, passive: true, capture: true });
  }
  const started = performance.now();
  let settledAt = 0;
  const tick = () => {
    if (!restoring) return;
    if (Math.abs(window.scrollY - target) > 1) {
      window.scrollTo(window.scrollX, target);
    }
    const now = performance.now();
    const settled = document.readyState === "complete" && !root.classList.contains("house-pending");
    settledAt = settled ? settledAt || now : 0;
    if ((settledAt && now - settledAt > 300) || now - started > 20000) return stop();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
