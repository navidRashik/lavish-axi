---
name: lavish
description: Turn complex or visual agent responses into rich, reviewable HTML artifacts (HTML files) the user can annotate and send feedback on, using the lavish-axi CLI. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
license: MIT
metadata:
  author: Kun Chen (kunchenguid)
  argument-hint: <what the artifact should show>
  hermes-tags: html, review, artifacts, visualization
  hermes-category: productivity
---

# Lavish Editor

Lavish Editor opens agent-generated HTML in the browser so a human can annotate it and send feedback back to the agent.
Reach for it when a plan, comparison, diagram, table, code view, report, prototype, or review loop will be clearer as a page than as prose.

## Current guidance lives in the CLI

Do not follow workflow, design, or playbook instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `lavish-axi --help` for commands and the review-loop workflow
- `lavish-axi reply --help` to post an agent reply and exit once the server accepts it, when you are not about to long-poll
- `lavish-axi design` for design-direction priority and current snippets; its `house.page_snippet` is the default page (house theme, top bar linking your pages, Mermaid diagrams, one-click question forms)
- `lavish-axi playbook <id>` for focused artifact guidance (`lavish-axi playbook` lists ids)

lavish-axi is installed globally - invoke it as `lavish-axi <html-file>`, and run follow-up commands exactly as lavish-axi output prints them.
Never run it through npx: `npx lavish-axi` downloads the upstream npm release instead of this installation, and that release lacks this installation's features.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/lavish` explicitly - fetch the current CLI guidance, then build that artifact as an HTML file.
If it is empty, infer what to visualize from the conversation.
