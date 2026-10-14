// Declarative bindings from page elements to the shared item store (docs/shared-state.md).
//
// Every helper here is serialized wholesale into the artifact SDK bundle by `createSdkJs`, so
// each one may reference only its own arguments, browser globals, or its sibling exports.

// The binding scope of an element is the nearest `data-lavish-ref` at or above it, so a ref nested
// inside another ref owns its own fields.
export function lavishStateScopeOf(element) {
  return element?.closest ? element.closest("[data-lavish-ref]") : null;
}

// `status=merged,closed` -> true when item.status is merged or closed. A missing item matches
// nothing, so `show-when` hides and `hide-when` shows until the store knows the item.
export function lavishStateConditionMatches(spec, item) {
  if (!item) return false;
  const text = String(spec || "");
  const at = text.indexOf("=");
  if (at <= 0) return false;
  const field = text.slice(0, at).trim();
  const values = text
    .slice(at + 1)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.includes(String(item[field] ?? ""));
}

export function lavishStateAgeText(updatedAt, now) {
  const at = Date.parse(String(updatedAt || ""));
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((Number(now) - at) / 1000));
  if (seconds < 60) return "updated just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return "updated " + minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return "updated " + hours + "h ago";
  return "updated " + Math.floor(hours / 24) + "d ago";
}

// "age" when the item is older than staleAfterHours; "source" when the page file it came from was
// modified after the item was written (the page moved on and the store did not); "" otherwise.
export function lavishStateStaleness(item, staleAfterHours, pageMtimes, now) {
  if (!item) return "";
  const at = Date.parse(String(item.updatedAt || ""));
  if (!Number.isFinite(at)) return "age";
  const hours = Number(staleAfterHours);
  if (Number.isFinite(hours) && hours > 0 && Number(now) - at > hours * 3_600_000) return "age";
  const sourceTime = Date.parse(String((pageMtimes || {})[String(item.source || "")] || ""));
  if (Number.isFinite(sourceTime) && sourceTime > at) return "source";
  return "";
}

// The answer a question scope holds right now: checked choices and filled fields, in document
// order. Empty when nothing is chosen, so the caller can fall back to the queued prompt text.
export function lavishStateQuestionAnswer(scope) {
  const parts = [];
  for (const control of scope?.querySelectorAll ? scope.querySelectorAll("input,select,textarea") : []) {
    if (control.disabled) continue;
    const type = String(control.type || "").toLowerCase();
    if (["button", "submit", "reset", "image", "hidden", "file"].includes(type)) continue;
    if (type === "checkbox" || type === "radio") {
      if (!control.checked) continue;
      const label = control.labels && control.labels[0] ? String(control.labels[0].textContent || "").trim() : "";
      parts.push(label || String(control.value || "on"));
    } else if (String(control.value || "").trim()) {
      parts.push(String(control.value).trim());
    }
  }
  return parts.join(", ");
}
// Answered on any page: every page showing this q ref disables its controls and shows the answer,
// either in an author-placed `data-lavish-field="answer"` element or in a Lavish-owned line.
export function lavishStateApplyQuestion(scope, item) {
  const answered = item?.status === "answered";
  for (const control of scope.querySelectorAll("input,select,textarea,button")) {
    if (answered && !control.disabled) {
      control.disabled = true;
      control.setAttribute("data-lavish-state-disabled", "");
    } else if (!answered && control.hasAttribute("data-lavish-state-disabled")) {
      control.disabled = false;
      control.removeAttribute("data-lavish-state-disabled");
    }
  }
  const authorField = [...scope.querySelectorAll("[data-lavish-field='answer']")].some(
    (field) => lavishStateScopeOf(field) === scope,
  );
  let line = scope.querySelector("[data-lavish-state-answer]");
  if (!answered || authorField) {
    if (line) line.remove();
    return;
  }
  if (!line) {
    line = scope.ownerDocument.createElement("p");
    line.setAttribute("data-lavish-state-answer", "");
    line.setAttribute("data-lavish-ui", "");
    scope.appendChild(line);
  }
  line.textContent = "Answered: " + String(item.answer || "");
}

export function lavishStateSetText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

/**
 * Render every bound element under `root` from `snapshot` ({ state, pageMtimes }). An id the store
 * does not hold only gets `data-lavish-status="unknown"`: the page's own baked values stay, since
 * they are the best information there is.
 * @param {any} root
 * @param {any} snapshot
 * @param {number} now
 */
export function applyLavishState(root, snapshot, now) {
  const state = snapshot?.state || {};
  const items = state.items || {};
  for (const scope of root.querySelectorAll("[data-lavish-ref]")) {
    const id = String(scope.getAttribute("data-lavish-ref") || "");
    const item = Object.prototype.hasOwnProperty.call(items, id) ? items[id] : null;
    if (!item) {
      scope.setAttribute("data-lavish-status", "unknown");
      continue;
    }
    scope.setAttribute("data-lavish-status", String(item.status || ""));
    const stale = lavishStateStaleness(item, state.staleAfterHours, snapshot?.pageMtimes, now);
    if (stale) scope.setAttribute("data-lavish-stale", stale);
    else scope.removeAttribute("data-lavish-stale");
    scope.classList.toggle("lavish-stale", Boolean(stale));
    const selector = "[data-lavish-field],[data-lavish-age],[data-lavish-show-when],[data-lavish-hide-when]";
    for (const element of [scope, ...scope.querySelectorAll(selector)]) {
      if (lavishStateScopeOf(element) !== scope) continue;
      const field = element.getAttribute("data-lavish-field");
      if (field && Object.prototype.hasOwnProperty.call(item, field)) lavishStateSetText(element, String(item[field]));
      if (element.hasAttribute("data-lavish-age")) lavishStateSetText(element, lavishStateAgeText(item.updatedAt, now));
      if (element.hasAttribute("data-lavish-show-when")) {
        element.hidden = !lavishStateConditionMatches(element.getAttribute("data-lavish-show-when"), item);
      }
      if (element.hasAttribute("data-lavish-hide-when")) {
        element.hidden = lavishStateConditionMatches(element.getAttribute("data-lavish-hide-when"), item);
      }
    }
    if (id.startsWith("q:") && scope.hasAttribute("data-lavish-question")) lavishStateApplyQuestion(scope, item);
  }
}
