import assert from "node:assert/strict";
import test from "node:test";

import { applyLavishQuestions } from "../src/question-visibility.js";

// A small DOM: tag, [attr] and [attr=value] selectors (comma lists), tree edits, click listeners and
// the few layout calls the renderer makes, so the renderer is tested without a browser.
const SIMPLE_SELECTOR = /^([a-z0-9]*)(?:\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/i;

function matchesOne(node, selector) {
  const [, tag, attr, value] = SIMPLE_SELECTOR.exec(selector.trim()) || [];
  if (tag === undefined && attr === undefined) throw new Error(`mock DOM cannot match ${selector}`);
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (attr && !node.hasAttribute(attr)) return false;
  if (attr && value !== undefined && node.getAttribute(attr) !== value) return false;
  return true;
}

class MockElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.listeners = [];
    this.text = "";
    this.style = { top: "", setProperty: (name, value) => (this.style[name] = value) };
    this.rendered = true;
    this.computed = { position: "static", top: "auto" };
    this.scrolledWith = null;
    this.focused = false;
    this.checked = false;
  }
  get type() {
    return this.getAttribute("type") || "";
  }
  get id() {
    return this.getAttribute("id") || "";
  }
  set id(value) {
    this.setAttribute("id", value);
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  get options() {
    return this.children.filter((child) => child.tagName === "OPTION");
  }
  get selected() {
    return this.hasAttribute("selected");
  }
  get value() {
    return this.getAttribute("value") || "";
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.children = [];
    this.text = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  setAttribute(name, value) {
    this.ownerDocument.writes += 1;
    this.attributes.set(name, String(value));
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.ownerDocument.writes += 1;
    this.attributes.delete(name);
  }
  matches(selectors) {
    return selectors.split(",").some((selector) => matchesOne(this, selector));
  }
  closest(selectors) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selectors)) return node;
    return null;
  }
  querySelectorAll(selectors) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selectors)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selectors) {
    return this.querySelectorAll(selectors)[0] || null;
  }
  get previousElementSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  get nextElementSibling() {
    const siblings = this.parentElement?.children || [];
    const index = siblings.indexOf(this);
    return index < 0 ? null : siblings[index + 1] || null;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, reference) {
    this.ownerDocument.writes += 1;
    child.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentElement = this;
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    this.ownerDocument.writes += 1;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  addEventListener(type, listener) {
    this.listeners.push([type, listener]);
  }
  click() {
    for (const [type, listener] of this.listeners) if (type === "click") listener();
  }
  getClientRects() {
    let node = this;
    while (node) {
      if (!node.rendered) return [];
      node = node.parentElement;
    }
    return [{}];
  }
  getBoundingClientRect() {
    return { height: 40 };
  }
  scrollIntoView(options) {
    this.scrolledWith = options;
  }
  focus() {
    this.focused = true;
  }
}

function page(build) {
  const doc = {
    writes: 0,
    createElement: (tag) => new MockElement(doc, tag),
    getElementById: (id) => doc.documentElement.querySelectorAll(`[id=${id}]`)[0] || null,
    querySelectorAll: (selectors) => doc.documentElement.querySelectorAll(selectors),
    querySelector: (selectors) => doc.documentElement.querySelector(selectors),
  };
  doc.documentElement = new MockElement(doc, "html");
  doc.head = doc.documentElement.appendChild(new MockElement(doc, "head"));
  doc.body = doc.documentElement.appendChild(new MockElement(doc, "body"));
  const h = (tag, attrs = {}, ...children) => {
    const element = new MockElement(doc, tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "checked") element.checked = Boolean(value);
      else element.attributes.set(name, String(value));
    }
    for (const child of children) {
      if (typeof child === "string") element.text += child;
      else element.appendChild(child);
    }
    return element;
  };
  for (const node of build(h)) doc.body.appendChild(node);
  const timers = [];
  const win = {
    setTimeout: (callback) => timers.push(callback),
    matchMedia: () => ({ matches: false }),
    getComputedStyle: (element) => element.computed,
    location: { hash: "" },
  };
  return { doc, win, timers, render: (items = null) => applyLavishQuestions(doc, items, win) };
}

const bar = (doc) => doc.querySelector("[data-lavish-qbar]");
const links = (doc) => bar(doc)?.querySelectorAll("button") || [];
const question = (h, id, legend, attrs = {}) =>
  h(
    "fieldset",
    { id, "data-lavish-question": id, ...attrs },
    h("legend", {}, legend),
    h("input", { type: "radio", name: id, value: "yes" }),
  );

test("no open question: no bar, and the page is not padded for one", () => {
  const { doc, render } = page((h) => [h("p", {}, "Nothing to decide here.")]);
  render();
  assert.equal(bar(doc), null);
  assert.equal(doc.documentElement.hasAttribute("data-lavish-qbar-open"), false);
});

test("one open question: a card with its class label and a bar reading '1 question waiting'", () => {
  const { doc, render } = page((h) => [question(h, "ship", "Ship it now? (commitment)")]);
  render();
  const card = doc.getElementById("ship");
  assert.equal(card.getAttribute("data-lavish-q"), "open");
  assert.equal(card.getAttribute("data-lavish-q-label"), " · commitment");
  assert.equal(bar(doc).querySelector("strong").textContent, "❓ 1 question waiting");
  assert.deepEqual(
    links(doc).map((link) => link.textContent),
    ["1. commitment: Ship it now? (commitment)"],
  );
  assert.equal(doc.documentElement.hasAttribute("data-lavish-qbar-open"), true);
});

test("many questions: answered ones, per-row checkboxes and repeated ids are not counted", () => {
  const { doc, render } = page((h) => [
    question(h, "a", "Scope: which repos?"),
    question(h, "b", "Behaviour: refuse by default?"),
    // Answered in the page: its only control is disabled.
    h(
      "form",
      { id: "done-form" },
      h("label", {}, "Merge order"),
      h("select", { "data-lavish-question": "done", disabled: "" }, h("option", { selected: "" }, "★ A first")),
    ),
    // Answered in the store on another page.
    question(h, "remote", "Remote question"),
    // A selection row, not a question.
    h("input", { type: "checkbox", "data-lavish-question": "row-1" }),
    // One question whose radios each repeat the id.
    h(
      "form",
      { id: "radios" },
      h("label", {}, "Pick one"),
      h("input", { type: "radio", "data-lavish-question": "c", value: "x" }),
      h("input", { type: "radio", "data-lavish-question": "c", value: "y" }),
    ),
  ]);
  render({ "q:remote": { status: "answered", answer: "Yes" } });
  assert.equal(bar(doc).querySelector("strong").textContent, "❓ 3 questions waiting");
  assert.deepEqual(
    links(doc).map((link) => link.textContent),
    ["1. scope: Scope: which repos?", "2. behaviour: Behaviour: refuse by default?", "3. Pick one"],
  );

  const doneForm = doc.getElementById("done-form");
  assert.equal(doneForm.getAttribute("data-lavish-q"), "answered");
  assert.equal(doneForm.previousElementSibling.textContent, "✅ answered: ★ A first");
  const remote = doc.getElementById("remote");
  assert.equal(remote.previousElementSibling.textContent, "✅ answered: Yes");
  assert.equal(doc.querySelectorAll("[data-lavish-q=open]").length, 3);
});

test("a question made only of buttons counts until its buttons are disabled, then collapses", () => {
  const { doc, render } = page((h) => [
    h("div", { id: "open-btn" }, h("button", { "data-lavish-question": "approve" }, "Approve")),
    h("div", { id: "done-btn" }, h("button", { "data-lavish-question": "rerun", disabled: "" }, "Rerun")),
  ]);
  render();
  assert.equal(bar(doc).querySelector("strong").textContent, "❓ 1 question waiting");
  assert.equal(doc.getElementById("open-btn").getAttribute("data-lavish-q"), "open");
  const done = doc.getElementById("done-btn");
  assert.equal(done.getAttribute("data-lavish-q"), "answered");
  assert.equal(done.previousElementSibling.textContent, "✅ answered");

  doc.getElementById("open-btn").querySelector("button").setAttribute("disabled", "");
  render();
  assert.equal(bar(doc), null);
});

test("the bar lists the oldest question first; undated ones follow in page order", () => {
  const { doc, render } = page((h) => [
    question(h, "undated", "Undated"),
    question(h, "new", "Newer", { "data-lavish-asked": "2026-10-19T10:00:00Z" }),
    question(h, "old", "Older", { "data-lavish-asked": "2026-10-18T09:00:00Z" }),
  ]);
  render();
  assert.deepEqual(
    links(doc).map((link) => link.textContent),
    ["1. Older", "2. Newer", "3. Undated"],
  );
});

test("a jump link scrolls to its own card, flashes it briefly and focuses its first control", () => {
  const { doc, render, timers } = page((h) => [question(h, "a", "First"), question(h, "b", "Second")]);
  render();
  links(doc)[1].click();
  const second = doc.getElementById("b");
  assert.equal(doc.getElementById("a").scrolledWith, null);
  assert.deepEqual(second.scrolledWith, { block: "start", behavior: "smooth" });
  assert.equal(second.hasAttribute("data-lavish-q-flash"), true);
  assert.equal(second.querySelector("input").focused, true);
  for (const timer of timers) timer();
  assert.equal(second.hasAttribute("data-lavish-q-flash"), false);
});

test("a jump link into an inactive tab activates the tab that labels the panel first", () => {
  const { doc, render } = page((h) => [
    h("button", { id: "tab-two", role: "tab" }, "Two"),
    h(
      "section",
      { id: "panel-two", role: "tabpanel", "aria-labelledby": "tab-two" },
      question(h, "hidden-q", "Hidden"),
    ),
  ]);
  const panel = doc.getElementById("panel-two");
  panel.rendered = false;
  let activated = false;
  doc.getElementById("tab-two").addEventListener("click", () => {
    activated = true;
    panel.rendered = true;
  });
  render();
  links(doc)[0].click();
  assert.equal(activated, true);
  assert.ok(doc.getElementById("hidden-q").scrolledWith);
});

test("answering the last question removes the bar; an unchanged page gets no DOM writes", () => {
  const { doc, render } = page((h) => [question(h, "only", "Only question")]);
  render();
  const writes = doc.writes;
  render();
  assert.equal(doc.writes, writes, "a second render with nothing changed writes nothing");

  doc.getElementById("only").querySelector("input").setAttribute("disabled", "");
  render();
  assert.equal(bar(doc), null);
  assert.equal(doc.documentElement.hasAttribute("data-lavish-qbar-open"), false);
  const line = doc.getElementById("only").previousElementSibling;
  assert.equal(line.textContent, "✅ answered");
  line.click();
  assert.equal(doc.getElementById("only").hasAttribute("data-lavish-q-expanded"), true);
  assert.equal(line.getAttribute("aria-expanded"), "true");
});

test("an author bar pinned at the top moves below the question bar and returns when it goes", () => {
  const { doc, render } = page((h) => [h("header", { id: "pinned" }, "Hub tabs"), question(h, "q", "Q")]);
  const pinned = doc.getElementById("pinned");
  pinned.computed = { position: "sticky", top: "0px" };
  render();
  assert.equal(pinned.style.top, "40px");
  doc.getElementById("q").querySelector("input").setAttribute("disabled", "");
  render();
  assert.equal(pinned.style.top, "");
  assert.equal(pinned.hasAttribute("data-lavish-q-top"), false);
});
