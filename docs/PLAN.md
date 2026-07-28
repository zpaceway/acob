# ACOB Feature Plan

This document turns the project review into an implementation roadmap. ACOB is intentionally a small, local-first Django service and Chromium extension; proposed features should preserve that simplicity unless a broader deployment model is explicitly adopted.

## Current Baseline

ACOB currently provides:

- Browser-specific asynchronous instruction queues with bounded batch claiming backed by SQLite.
- Chromium tab listing, URL navigation, focusing, and closing.
- Real coordinate-based mouse clicks through the Chromium Debugger API.
- Focused-control text entry, named keys, and modified keyboard shortcuts.
- Viewport and full-page PNG capture through single-use download endpoints.
- Arbitrary JavaScript evaluation with promise support and CSP-independent execution.
- One-shot terminal result consumption.
- An asynchronous Python client with concurrent instruction submission and polling.
- Strict Pydantic request validation, Docker support, and agent integration through `SKILL.md`.

## Current Milestone

### Transient Instructions

Status: implemented.

Instruction rows are transport state, not history. They should remain available while `pending` or `processing` so agents can poll safely. The first agent request that reads a `completed` or `failed` instruction will return the terminal response and atomically delete the row. Later reads will return `404 Instruction not found`.

Agent documentation must make the one-shot behavior explicit: capture every terminal response immediately and never expect a terminal instruction to be retrievable twice.

### Screenshots

Status: implemented.

Add a `screenshot` action targeting a tab. It should support viewport capture and optional full-page capture through the Chromium Debugger API.

Screenshot bytes will cross the extension API as base64 and be stored base64-encoded in a dedicated transient database table. Encoded captures are limited to 30 MiB so an oversized result can fail cleanly below the server request limit. The completed instruction result will contain screenshot metadata and a browser-scoped download endpoint, never the base64 payload itself.

The first successful request to the download endpoint will decode and return the image, then atomically delete its database row. Later downloads will return 404. Agents must save or process the first response because interrupted or repeated downloads are not recoverable.

### Keyboard Input

Status: implemented.

Add a `keyboard` action targeting the element that currently has keyboard focus in a tab. It should support:

- Text input through Chromium's text-input command.
- Individual keys such as Enter, Tab, Escape, Backspace, Delete, and arrow keys.
- Optional Alt, Ctrl, Meta, and Shift modifiers for shortcuts.

The action should leave tab and window focus unchanged while dispatching input. Agents should click or otherwise focus the intended page control before typing.

### Tab Navigation

Status: implemented.

Use `tabs.navigate` with a required non-empty `url` and an optional `tid`:

- With `tid`, navigate that existing tab and return its details after load.
- Without `tid`, create a new inactive tab at the URL and return its details after load.

`tabs.new` is not supported. Agents use `tabs.navigate` for both new and existing tabs.

### Explicit Non-Goals

Status: deferred by decision.

- Do not add a `scroll` action now. JavaScript and click's existing scroll-into-view behavior cover current needs.
- Do not add a `wait` action. Agents can wait or poll on their side, and JavaScript remains available for bounded page-side readiness checks.

## Candidate Next Milestone

### Browser State And Inspection

- Add a constrained extraction action for text, HTML, and attributes when arbitrary JavaScript is unnecessary.
- Add cookie inspection and mutation for authentication workflows.
- Add opt-in network request and response monitoring through Chromium's Network domain.

### Extension Reliability

- Add a browser heartbeat so agents can distinguish an idle browser from a disconnected extension.
- Evaluate Server-Sent Events or WebSockets as a lower-latency replacement for one-second polling.
- Evaluate `chrome.storage.sync` for browser identity recovery while preserving intentional queue rotation.

### API Hardening

- Add an optional shared API token before supporting non-localhost deployments.
- Add rate limits and instruction payload size limits.
- Add expiry cleanup for instructions that are never completed or consumed and screenshots that are never downloaded.
- Add a small operational dashboard and paginated queue listing only if queue diagnostics become necessary; consumed results should not be restored as history by default.
- Add structured logging and a health-check endpoint.
- Move secret key, debug mode, and allowed hosts to environment configuration before production use.
- Add reverse-proxy TLS, PostgreSQL, and explicit tenant isolation before supporting remote multi-user operation.

## Longer-Term Candidates

- File upload and controlled download handling.
- JavaScript dialog acceptance, dismissal, and prompt input.
- Viewport, device, user-agent, geolocation, and locale emulation.
- Composite instruction batches to reduce round trips while preserving clear failure boundaries.
- Performance and Core Web Vitals collection.
- Result callbacks or webhooks for integrations that cannot poll.
- OpenAPI documentation generated from the request and response contracts.
- Optional instruction history only if audit requirements emerge; transient storage remains the default.

## Project Maintenance

- Add a license before wider distribution.
- Add `CONTRIBUTING.md` and a changelog when external contributions or releases begin.
- Keep `README.md`, `SKILL.md`, API schemas, extension behavior, migrations, and tests synchronized for every action or lifecycle change.
