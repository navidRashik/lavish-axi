// Question visibility: every unanswered `data-lavish-question` renders as a "❓ YOUR CALL" card, a
// fixed bar at the top counts the open ones with a jump link to each, and an answered question
// collapses to one muted "✅ answered: <pick>" line.
//
// Every helper here is serialized wholesale into the artifact SDK bundle by `createSdkJs`, so each
// one may reference only its own arguments, browser globals, or its sibling exports.

// Colours are self-contained pairs (each text colour is measured against its own background), so
// contrast holds whatever the page paints. `tint` is the only translucent colour: it lays over the
// page's own background and keeps the page's own text readable. test/question-contrast.test.js
// measures every pair against WCAG 2.2 AA.
export function lavishQuestionPalette() {
  return {
    light: {
      border: "#8f5a00",
      tint: [143, 90, 0, 0.08],
      labelBg: "#8f5a00",
      labelFg: "#ffffff",
      barBg: "#8f5a00",
      barFg: "#ffffff",
      linkBg: "#fff7e6",
      linkFg: "#5c3a00",
      barFocus: "#ffffff",
      focus: "#2b5797",
      mutedBg: "#eef0f3",
      mutedFg: "#4f5967",
    },
    dark: {
      border: "#e2b35a",
      tint: [226, 179, 90, 0.14],
      labelBg: "#e2b35a",
      labelFg: "#16191e",
      barBg: "#e2b35a",
      barFg: "#16191e",
      linkBg: "#16191e",
      linkFg: "#f3d08f",
      barFocus: "#16191e",
      focus: "#8fb3ec",
      mutedBg: "#272b31",
      mutedFg: "#a9b0bb",
    },
  };
}

export function lavishQuestionCss() {
  const palette = lavishQuestionPalette();
  const vars = (p) =>
    `--lavish-q-border:${p.border};--lavish-q-tint:rgba(${p.tint.join(",")});` +
    `--lavish-q-label-bg:${p.labelBg};--lavish-q-label-fg:${p.labelFg};--lavish-q-bar-bg:${p.barBg};` +
    `--lavish-q-bar-fg:${p.barFg};--lavish-q-link-bg:${p.linkBg};--lavish-q-link-fg:${p.linkFg};` +
    `--lavish-q-bar-focus:${p.barFocus};--lavish-q-focus:${p.focus};--lavish-q-muted-bg:${p.mutedBg};` +
    `--lavish-q-muted-fg:${p.mutedFg};`;
  const font = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
  return [
    `:root{${vars(palette.light)}}`,
    `@media (prefers-color-scheme:dark){:root{${vars(palette.dark)}}}`,
    `[data-lavish-q="open"]{border-left:6px solid var(--lavish-q-border)!important;background-color:var(--lavish-q-tint)!important;border-radius:8px!important;padding:.75rem 1rem!important;margin-block:.75rem!important;scroll-margin-top:calc(var(--lavish-qbar-h,0px) + 16px)}`,
    `[data-lavish-q="open"]::before{content:"❓ YOUR CALL" attr(data-lavish-q-label);display:block;width:max-content;max-width:100%;box-sizing:border-box;margin:0 0 .5rem;padding:.15rem .6rem;border-radius:999px;background:var(--lavish-q-label-bg);color:var(--lavish-q-label-fg);font:700 .8rem/1.5 ${font};letter-spacing:.02em}`,
    `[data-lavish-q="open"] :is(input,select,textarea,button,a,summary):focus-visible{outline:3px solid var(--lavish-q-focus)!important;outline-offset:2px!important}`,
    `[data-lavish-q-flash]{outline:4px solid var(--lavish-q-border)!important;outline-offset:4px!important;animation:lavish-q-flash 1.6s ease-out}`,
    `@keyframes lavish-q-flash{0%{box-shadow:0 0 0 12px var(--lavish-q-border)}100%{box-shadow:0 0 0 0 transparent}}`,
    `@media (prefers-reduced-motion:reduce){[data-lavish-q-flash]{animation:none}}`,
    `[data-lavish-q="answered"]:not([data-lavish-q-expanded]),[data-lavish-q-hidden]{display:none!important}`,
    `[data-lavish-q-line]{display:block;box-sizing:border-box;max-width:100%;margin:.35rem 0;padding:.2rem .6rem;border:0;border-radius:6px;background:var(--lavish-q-muted-bg);color:var(--lavish-q-muted-fg);font:400 .85rem/1.5 ${font};text-align:left;cursor:pointer}`,
    `[data-lavish-q-line]:focus-visible{outline:3px solid var(--lavish-q-focus);outline-offset:2px}`,
    `[data-lavish-qbar]{position:fixed;top:0;left:0;right:0;z-index:2147483000;box-sizing:border-box;display:flex;align-items:center;gap:.5rem;padding:.45rem .75rem;background:var(--lavish-q-bar-bg);color:var(--lavish-q-bar-fg);font:700 .9rem/1.5 ${font};box-shadow:0 2px 6px rgba(0,0,0,.25);overflow-x:auto;white-space:nowrap}`,
    `[data-lavish-qbar] button{flex:none;margin:0;border:0;border-radius:999px;padding:.2rem .7rem;background:var(--lavish-q-link-bg);color:var(--lavish-q-link-fg);font:600 .82rem/1.5 ${font};cursor:pointer}`,
    `[data-lavish-qbar] button:focus-visible{outline:3px solid var(--lavish-q-bar-focus);outline-offset:2px}`,
    `html[data-lavish-qbar-open]{padding-top:var(--lavish-qbar-h,44px)!important;scroll-padding-top:calc(var(--lavish-qbar-h,44px) + 16px)}`,
  ].join("\n");
}

// "scope" | "behaviour" | "commitment" | "implementer" | "" from free text.
export function lavishQuestionClassName(text) {
  const match = /\b(scope|behaviou?r|commitment|implementer)\b/i.exec(String(text || ""));
  if (!match) return "";
  const word = match[1].toLowerCase();
  return word.startsWith("behavio") ? "behaviour" : word;
}

// The element that shows a question: the scope itself, or the form/fieldset around a control that
// carries the question directly.
export function lavishQuestionCard(scope) {
  if (!scope.matches("input,select,textarea,button")) return scope;
  return scope.closest("fieldset,form") || scope.parentElement || scope;
}

// The question's own wording: the first legend, summary, heading or label in its card.
export function lavishQuestionHeading(card) {
  const heading = card.querySelector("legend,summary,h1,h2,h3,h4,h5,h6,label");
  return heading
    ? String(heading.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

export function lavishQuestionControls(scope) {
  const own = scope.matches("input,select,textarea") ? [scope] : [];
  return [...own, ...scope.querySelectorAll("input,select,textarea")].filter(
    (control) => !["button", "submit", "reset", "image", "hidden"].includes(String(control.type || "").toLowerCase()),
  );
}

// Answered in the shared store, or answered in the page: every value control it holds is disabled
// (directly or by a disabled fieldset). A question made only of buttons is answered when every
// button is disabled. A question with no controls at all stays open.
export function lavishQuestionAnswered(scope, item) {
  if (item?.status === "answered") return true;
  const off = (control) => control.disabled || !!control.closest("fieldset[disabled]");
  const controls = lavishQuestionControls(scope);
  if (controls.length) return controls.every(off);
  const own = scope.matches("button,input") ? [scope] : [];
  const buttons = [...own, ...scope.querySelectorAll("button,input")].filter(
    (control) => String(control.type || "").toLowerCase() !== "hidden",
  );
  return buttons.length > 0 && buttons.every(off);
}

// What was picked: the store's answer, else an author-written "✅ …" line, else the selected
// values of the (disabled) controls.
export function lavishQuestionPick(scope, card, item, source) {
  if (item?.status === "answered" && String(item.answer || "").trim()) return String(item.answer).trim();
  const authored = [source, ...card.querySelectorAll("p,span,div,b,strong,em")].find(
    (element) => element && /^✅/.test(String(element.textContent || "").trim()),
  );
  if (authored) {
    const text = String(authored.textContent).replace(/\s+/g, " ").trim();
    return text.replace(/^✅\s*(?:YOUR PICK|answered|closed[^:]*)?\s*:?\s*/i, "");
  }
  const parts = [];
  for (const control of lavishQuestionControls(scope)) {
    const type = String(control.type || "").toLowerCase();
    if (String(control.tagName || "").toLowerCase() === "select") {
      for (const option of control.options || []) {
        if (option.selected) parts.push(String(option.textContent || option.value || "").trim());
      }
    } else if (type === "checkbox" || type === "radio") {
      if (!control.checked) continue;
      const label = control.labels && control.labels[0] ? String(control.labels[0].textContent || "").trim() : "";
      parts.push(label || String(control.value || ""));
    } else if (String(control.value || "").trim()) {
      parts.push(String(control.value).trim());
    }
  }
  return parts.filter(Boolean).join(", ");
}

// Every question on the page, once per id, in document order. A per-row checkbox is a selection,
// not a question, and Lavish's own UI is never a question.
export function lavishQuestionCollect(root, items) {
  const seen = new Set();
  const questions = [];
  for (const scope of root.querySelectorAll("[data-lavish-question]")) {
    if (scope.closest("[data-lavish-ui]")) continue;
    const tag = String(scope.tagName || "").toLowerCase();
    if (tag === "input" && String(scope.type || "").toLowerCase() === "checkbox") continue;
    const id = String(scope.getAttribute("data-lavish-question") || "").trim();
    const card = lavishQuestionCard(scope);
    const key = id ? "q:" + id : card;
    if (seen.has(key)) continue;
    seen.add(key);
    const explicitRef = scope.getAttribute("data-lavish-ref");
    const ref = explicitRef !== null ? String(explicitRef) : id ? "q:" + id : "";
    const item = ref && items && Object.prototype.hasOwnProperty.call(items, ref) ? items[ref] : null;
    const heading = lavishQuestionHeading(card);
    const declared =
      scope.getAttribute("data-lavish-question-class") || card.getAttribute("data-lavish-question-class");
    const askedHost = scope.closest("[data-lavish-asked]");
    const asked = askedHost ? Date.parse(String(askedHost.getAttribute("data-lavish-asked"))) : NaN;
    questions.push({
      id,
      scope,
      card,
      item,
      answered: lavishQuestionAnswered(scope, item),
      cls: lavishQuestionClassName(declared || heading),
      title: heading || id || "Question",
      asked: Number.isFinite(asked) ? asked : null,
    });
  }
  return questions;
}

// The bar's content: open questions only, oldest first by `data-lavish-asked`; undated questions
// follow in document order.
export function lavishQuestionBarModel(questions) {
  const open = questions
    .filter((question) => !question.answered)
    .map((question, order) => ({ question, order }))
    .sort((a, b) => {
      const at = a.question.asked;
      const bt = b.question.asked;
      if (at !== null && bt !== null && at !== bt) return at - bt;
      if ((at === null) !== (bt === null)) return at === null ? 1 : -1;
      return a.order - b.order;
    })
    .map((entry) => entry.question);
  const count = open.length;
  const short = (text) => (text.length > 60 ? text.slice(0, 59) + "…" : text);
  return {
    count,
    text: count === 1 ? "❓ 1 question waiting" : `❓ ${count} questions waiting`,
    links: open.map((question, index) => ({
      label: `${index + 1}. ${question.cls ? question.cls + ": " : ""}${short(question.title)}`,
      card: question.card,
    })),
  };
}

export function lavishQuestionSetAttr(element, name, value) {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

// Bring a question card into view and flash it. A card inside an inactive tab panel first gets its
// tab activated, through the tab that labels or controls the panel, else the panel's hash.
export function lavishQuestionReveal(card, win) {
  const doc = card.ownerDocument;
  const panel = card.closest("[role=tabpanel]");
  if (panel && panel.id && card.getClientRects().length === 0) {
    const labelledBy = panel.getAttribute("aria-labelledby");
    const tab =
      (labelledBy && doc.getElementById(labelledBy)) ||
      [...doc.querySelectorAll("[aria-controls]")].find((el) => el.getAttribute("aria-controls") === panel.id) ||
      [...doc.querySelectorAll("a[href]")].find((el) => el.getAttribute("href") === "#" + panel.id);
    if (tab) tab.click();
    else win.location.hash = panel.id;
  }
  const reduce = Boolean(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
  card.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  card.setAttribute("data-lavish-q-flash", "");
  win.setTimeout(() => card.removeAttribute("data-lavish-q-flash"), 1600);
  const control = lavishQuestionControls(card).find((element) => !element.disabled);
  if (control) control.focus({ preventScroll: true });
}

// Author elements pinned to the top (sticky or fixed at top 0) move down by the bar's height while
// the bar shows, so the bar never hides them; their own inline `top` comes back when it goes.
export function lavishQuestionShiftPinned(doc, win, height) {
  const candidates = [];
  for (const child of doc.body.children) {
    candidates.push(child);
    for (const grandchild of child.children) candidates.push(grandchild);
  }
  for (const element of candidates) {
    if (element.hasAttribute("data-lavish-ui")) continue;
    if (element.hasAttribute("data-lavish-q-top")) {
      if (height === null) {
        element.style.top = element.getAttribute("data-lavish-q-top");
        element.removeAttribute("data-lavish-q-top");
      } else {
        element.style.top = height + "px";
      }
      continue;
    }
    if (height === null) continue;
    const style = win.getComputedStyle(element);
    if ((style.position === "sticky" || style.position === "fixed") && style.top === "0px") {
      element.setAttribute("data-lavish-q-top", element.style.top || "");
      element.style.top = height + "px";
    }
  }
}

// The muted line that stands in for an answered card; it toggles the card open and shut.
export function lavishQuestionLine(doc, card) {
  const previous = card.previousElementSibling;
  if (previous && previous.hasAttribute("data-lavish-q-line")) return previous;
  const line = doc.createElement("button");
  line.setAttribute("type", "button");
  line.setAttribute("data-lavish-ui", "");
  line.setAttribute("data-lavish-q-line", "");
  line.setAttribute("aria-expanded", "false");
  line.addEventListener("click", () => {
    const target = line.nextElementSibling;
    if (!target) return;
    const expand = !target.hasAttribute("data-lavish-q-expanded");
    lavishQuestionSetAttr(target, "data-lavish-q-expanded", expand ? "" : null);
    line.setAttribute("aria-expanded", String(expand));
  });
  card.parentElement.insertBefore(line, card);
  return line;
}

// The bar: hidden (removed) at zero open questions, else a count and one jump button per question.
export function lavishQuestionRenderBar(doc, win, model) {
  let bar = doc.querySelector("[data-lavish-qbar]");
  if (!model.count) {
    if (bar) {
      bar.remove();
      lavishQuestionShiftPinned(doc, win, null);
    }
    lavishQuestionSetAttr(doc.documentElement, "data-lavish-qbar-open", null);
    return null;
  }
  const signature = model.links.map((link) => link.label).join("\n");
  if (!bar) {
    bar = doc.createElement("nav");
    bar.setAttribute("data-lavish-ui", "");
    bar.setAttribute("data-lavish-qbar", "");
    bar.setAttribute("aria-label", "Questions waiting for you");
    doc.body.insertBefore(bar, doc.body.firstChild);
  }
  bar.lavishCards = model.links.map((link) => link.card);
  if (bar.getAttribute("data-lavish-qbar-sig") === signature) return bar;
  bar.textContent = "";
  const count = doc.createElement("strong");
  count.textContent = model.text;
  bar.appendChild(count);
  model.links.forEach((link, index) => {
    const button = doc.createElement("button");
    button.setAttribute("type", "button");
    button.textContent = link.label;
    button.addEventListener("click", () => lavishQuestionReveal(bar.lavishCards[index], win));
    bar.appendChild(button);
  });
  bar.setAttribute("data-lavish-qbar-sig", signature);
  lavishQuestionSetAttr(doc.documentElement, "data-lavish-qbar-open", "");
  const height = Math.ceil(bar.getBoundingClientRect().height);
  doc.documentElement.style.setProperty("--lavish-qbar-h", height + "px");
  lavishQuestionShiftPinned(doc, win, height);
  return bar;
}

// Render question cards, answered lines and the bar for `doc`. Idempotent: an unchanged page gets
// no DOM writes, so a MutationObserver that calls this settles after one pass.
export function applyLavishQuestions(doc, items, win) {
  if (!doc.body) return;
  if (!doc.getElementById("lavish-question-style")) {
    const style = doc.createElement("style");
    style.id = "lavish-question-style";
    style.setAttribute("data-lavish-ui", "");
    style.textContent = lavishQuestionCss();
    (doc.head || doc.documentElement).appendChild(style);
  }
  const questions = lavishQuestionCollect(doc, items);
  const cards = new Map();
  for (const question of questions) {
    const entry = cards.get(question.card) || { open: false, cls: "", answered: [] };
    if (question.answered) entry.answered.push(question);
    else {
      entry.open = true;
      entry.cls = entry.cls || question.cls;
    }
    cards.set(question.card, entry);
  }
  for (const marked of doc.querySelectorAll("[data-lavish-q]")) {
    if (cards.has(marked)) continue;
    for (const name of ["data-lavish-q", "data-lavish-q-label", "data-lavish-q-expanded"]) {
      lavishQuestionSetAttr(marked, name, null);
    }
    const stale = marked.previousElementSibling;
    if (stale && stale.hasAttribute("data-lavish-q-line")) stale.remove();
  }
  const answeredMarks = [...doc.querySelectorAll("[data-lavish-question-answered]")];
  for (const [card, entry] of cards) {
    lavishQuestionSetAttr(card, "data-lavish-q", entry.open ? "open" : "answered");
    lavishQuestionSetAttr(card, "data-lavish-q-label", entry.open && entry.cls ? " · " + entry.cls : null);
    const sources = entry.answered.map(
      (question) =>
        (question.id && answeredMarks.find((el) => el.getAttribute("data-lavish-question-answered") === question.id)) ||
        null,
    );
    for (const source of sources) {
      if (source) lavishQuestionSetAttr(source, "data-lavish-q-hidden", entry.open ? null : "");
    }
    if (entry.open) {
      const previous = card.previousElementSibling;
      if (previous && previous.hasAttribute("data-lavish-q-line")) previous.remove();
      lavishQuestionSetAttr(card, "data-lavish-q-expanded", null);
      continue;
    }
    const picks = entry.answered
      .map((question, index) => lavishQuestionPick(question.scope, card, question.item, sources[index]))
      .filter(Boolean);
    const text = "✅ answered" + (picks.length ? ": " + picks.join("; ") : "");
    const line = lavishQuestionLine(doc, card);
    if (line.textContent !== text) line.textContent = text;
  }
  lavishQuestionRenderBar(doc, win, lavishQuestionBarModel(questions));
}
