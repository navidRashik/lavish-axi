import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLavishState,
  lavishStateAgeText,
  lavishStateConditionMatches,
  lavishStateQuestionAnswer,
  lavishStateStaleness,
} from "../src/state-bindings.js";

// A minimal element tree: enough selector support for the attribute and tag selectors the
// bindings use, so the logic is tested without a browser (the e2e covers a real one).
const doc = { createElement: (tag) => el(tag) };

function el(tag, attrs = {}, children = [], props = {}) {
  const attributes = new Map(Object.entries(attrs));
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(),
    ownerDocument: doc,
    parentElement: null,
    children: [],
    hidden: false,
    disabled: false,
    _text: "",
    ...props,
    get textContent() {
      return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text;
    },
    set textContent(value) {
      this.children = [];
      this._text = String(value);
    },
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    hasAttribute: (name) => attributes.has(name),
    removeAttribute: (name) => attributes.delete(name),
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    appendChild(child) {
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
    remove() {
      const parent = node.parentElement;
      if (parent) parent.children = parent.children.filter((child) => child !== node);
      node.parentElement = null;
    },
    matches: (selector) => selector.split(",").some((part) => matchesOne(node, part.trim())),
    closest(selector) {
      for (let current = node; current; current = current.parentElement) {
        if (current.matches(selector)) return current;
      }
      return null;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (parent) => {
        for (const child of parent.children) {
          if (child.matches(selector)) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    },
    querySelector: (selector) => node.querySelectorAll(selector)[0] || null,
  };
  for (const child of children) node.appendChild(child);
  return node;
}

function matchesOne(node, selector) {
  const valued = selector.match(/^\[([\w-]+)='([^']*)'\]$/);
  if (valued) return node.getAttribute(valued[1]) === valued[2];
  const present = selector.match(/^\[([\w-]+)\]$/);
  if (present) return node.hasAttribute(present[1]);
  return node.tagName.toLowerCase() === selector;
}

const NOW = Date.parse("2026-10-14T15:00:00Z");

function snapshot(items, extra = {}) {
  return { state: { version: 1, staleAfterHours: 24, items }, pageMtimes: {}, ...extra };
}

test("condition specs match a field against a comma list", () => {
  const item = { status: "merged", review: "needs-you" };
  assert.equal(lavishStateConditionMatches("status=merged,closed", item), true);
  assert.equal(lavishStateConditionMatches("status=open", item), false);
  assert.equal(lavishStateConditionMatches("review=needs-you", item), true);
  assert.equal(lavishStateConditionMatches("garbage", item), false);
  assert.equal(lavishStateConditionMatches("status=merged", null), false);
});

test("age text reads like a person would say it", () => {
  assert.equal(lavishStateAgeText("2026-10-14T14:59:30Z", NOW), "updated just now");
  assert.equal(lavishStateAgeText("2026-10-14T14:15:00Z", NOW), "updated 45m ago");
  assert.equal(lavishStateAgeText("2026-10-14T12:00:00Z", NOW), "updated 3h ago");
  assert.equal(lavishStateAgeText("2026-10-10T15:00:00Z", NOW), "updated 4d ago");
  assert.equal(lavishStateAgeText("not a date", NOW), "");
});

test("staleness is age past staleAfterHours, or a source page edited after the write", () => {
  const fresh = { updatedAt: "2026-10-14T14:00:00Z", source: "index.html" };
  assert.equal(lavishStateStaleness(fresh, 24, {}, NOW), "");
  assert.equal(lavishStateStaleness({ ...fresh, updatedAt: "2026-10-13T14:00:00Z" }, 24, {}, NOW), "age");
  assert.equal(lavishStateStaleness(fresh, 24, { "index.html": "2026-10-14T14:30:00Z" }, NOW), "source");
  assert.equal(lavishStateStaleness(fresh, 24, { "index.html": "2026-10-14T13:00:00Z" }, NOW), "");
  assert.equal(lavishStateStaleness({ source: "github" }, 24, {}, NOW), "age");
});

test("applyLavishState renders fields, status, visibility and age from one item", () => {
  const status = el("span", { "data-lavish-field": "status" });
  status.textContent = "open";
  const merged = el("em", { "data-lavish-show-when": "status=merged,closed" });
  const needsYou = el("b", { "data-lavish-hide-when": "review=needs-you" });
  const age = el("small", { "data-lavish-age": "" });
  const card = el("article", { "data-lavish-ref": "pr:x/y#1" }, [status, merged, needsYou, age]);
  const root = el("main", {}, [card]);

  applyLavishState(
    root,
    snapshot({
      "pr:x/y#1": { status: "merged", review: "needs-you", updatedAt: "2026-10-14T12:00:00Z", source: "github" },
    }),
    NOW,
  );

  assert.equal(card.getAttribute("data-lavish-status"), "merged");
  assert.equal(status.textContent, "merged");
  assert.equal(merged.hidden, false);
  assert.equal(needsYou.hidden, true);
  assert.equal(age.textContent, "updated 3h ago");
  assert.equal(card.classList.contains("lavish-stale"), false);
});

test("every element bound to the same id agrees", () => {
  const first = el("span", { "data-lavish-ref": "ticket:A-1", "data-lavish-field": "status" });
  const second = el("span", { "data-lavish-ref": "ticket:A-1", "data-lavish-field": "status" });
  const root = el("main", {}, [el("section", {}, [first]), el("section", {}, [second])]);
  applyLavishState(root, snapshot({ "ticket:A-1": { status: "In Review", updatedAt: "2026-10-14T14:00:00Z" } }), NOW);
  assert.equal(first.textContent, "In Review");
  assert.equal(second.textContent, "In Review");
});

test("a nested ref owns its own fields", () => {
  const inner = el("span", { "data-lavish-field": "status" });
  const innerRef = el("div", { "data-lavish-ref": "worker:w1" }, [inner]);
  const outer = el("div", { "data-lavish-ref": "pr:x/y#1" }, [innerRef]);
  applyLavishState(
    el("main", {}, [outer]),
    snapshot({
      "pr:x/y#1": { status: "merged", updatedAt: "2026-10-14T14:00:00Z" },
      "worker:w1": { status: "running", updatedAt: "2026-10-14T14:00:00Z" },
    }),
    NOW,
  );
  assert.equal(inner.textContent, "running");
});

test("an id the store does not hold keeps the page's baked values", () => {
  const status = el("span", { "data-lavish-field": "status" });
  status.textContent = "draft";
  const shown = el("em", { "data-lavish-show-when": "status=merged" });
  const card = el("div", { "data-lavish-ref": "pr:x/y#2" }, [status, shown]);
  applyLavishState(el("main", {}, [card]), snapshot({}), NOW);
  assert.equal(card.getAttribute("data-lavish-status"), "unknown");
  assert.equal(status.textContent, "draft");
  assert.equal(shown.hidden, false);
});

test("stale items are marked with the class and the reason", () => {
  const card = el("div", { "data-lavish-ref": "pr:x/y#1" });
  const root = el("main", {}, [card]);
  applyLavishState(root, snapshot({ "pr:x/y#1": { status: "open", updatedAt: "2026-10-12T00:00:00Z" } }), NOW);
  assert.equal(card.getAttribute("data-lavish-stale"), "age");
  assert.equal(card.classList.contains("lavish-stale"), true);
  applyLavishState(root, snapshot({ "pr:x/y#1": { status: "open", updatedAt: "2026-10-14T14:59:00Z" } }), NOW);
  assert.equal(card.getAttribute("data-lavish-stale"), null);
  assert.equal(card.classList.contains("lavish-stale"), false);
});

test("an answered question disables its controls and shows the answer; reopening restores them", () => {
  const yes = el("input", {}, [], { type: "radio", value: "yes" });
  const button = el("button", {});
  const preDisabled = el("input", {}, [], { type: "text", disabled: true });
  const question = el("fieldset", { "data-lavish-question": "merge", "data-lavish-ref": "q:merge" }, [
    yes,
    button,
    preDisabled,
  ]);
  const root = el("main", {}, [question]);

  applyLavishState(
    root,
    snapshot({ "q:merge": { status: "answered", answer: "yes", updatedAt: "2026-10-14T14:00:00Z" } }),
    NOW,
  );
  assert.equal(yes.disabled, true);
  assert.equal(button.disabled, true);
  assert.equal(question.querySelector("[data-lavish-state-answer]").textContent, "Answered: yes");

  applyLavishState(root, snapshot({ "q:merge": { status: "open", updatedAt: "2026-10-14T14:00:00Z" } }), NOW);
  assert.equal(yes.disabled, false);
  assert.equal(button.disabled, false);
  assert.equal(preDisabled.disabled, true, "a control the author disabled stays disabled");
  assert.equal(question.querySelector("[data-lavish-state-answer]"), null);
});

test("an author-placed answer field replaces the Lavish answer line", () => {
  const answer = el("output", { "data-lavish-field": "answer" });
  const question = el("div", { "data-lavish-question": "q1", "data-lavish-ref": "q:q1" }, [answer]);
  applyLavishState(el("main", {}, [question]), snapshot({ "q:q1": { status: "answered", answer: "ship it" } }), NOW);
  assert.equal(answer.textContent, "ship it");
  assert.equal(question.querySelector("[data-lavish-state-answer]"), null);
});

test("a question's answer is its checked choices and filled fields", () => {
  const label = el("label");
  label.textContent = "Merge now";
  const choice = el("input", {}, [], { type: "radio", checked: true, value: "now", labels: [label] });
  const skipped = el("input", {}, [], { type: "radio", checked: false, value: "later" });
  const note = el("textarea", {}, [], { value: " after CI " });
  const submit = el("input", {}, [], { type: "submit", value: "Send" });
  assert.equal(lavishStateQuestionAnswer(el("div", {}, [choice, skipped, note, submit])), "Merge now, after CI");
  assert.equal(lavishStateQuestionAnswer(el("div")), "");
});
