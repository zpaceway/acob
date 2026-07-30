# ACOB Feature Plan

This document is the living implementation roadmap for ACOB. It reflects the
project audit completed in July 2026 and supersedes the earlier candidate list.

ACOB is intentionally a small, local-first, component-owned monorepo: Django
server, Chromium extension, asynchronous Python client, agent documentation,
and static website. The project should become safer, more reliable, and more
semantic before it becomes broader.

## Product Direction

ACOB controls a user's existing Chromium session instead of provisioning a
hosted browser. Its strongest product qualities are:

- Existing authenticated sessions remain in the user's browser.
- Browser work is routed locally through explicit browser identities.
- Real pointer and keyboard input remain available alongside JavaScript.
- Results are transient and private by default.
- Agents receive a typed API and operational guidance rather than a raw CDP
  connection.

The next stages should turn that foundation into trustworthy local browser
control, then add a bounded semantic page model, and only then add richer
testing and workflow capabilities.

## Engineering Principles

- Keep local operation safe by default. Network deployment must be an explicit
  choice with additional controls.
- Keep browser-side policy under the user's control. Remote instructions must
  not be able to weaken extension-owned restrictions.
- Prefer typed, bounded actions for common work and retain JavaScript as the
  explicit escape hatch.
- Preserve real browser behavior for pointer and keyboard interactions.
- Treat unknown outcomes honestly. Never claim exactly-once browser side
  effects when execution may have succeeded before delivery failed.
- Keep results transient, but acknowledge delivery before deletion.
- Bound page content, event capture, files, queue depth, and execution time.
- Preserve parallelism across tabs while serializing debugger-backed work
  within one tab.
- Keep server schemas, extension contracts, client models, migrations, tests,
  READMEs, and `SKILL.md` synchronized.

## Current Baseline

### Server And Transport

- Browser-specific asynchronous instruction queues backed by SQLite.
- Bounded batch claiming with conditional pending-to-processing updates.
- Strict Pydantic request validation with unknown fields rejected.
- Transient instruction rows that remain readable while `pending` or
  `processing`.
- One-shot terminal instruction consumption for `completed` and `failed`
  results.
- Dedicated transient screenshot storage with a 30 MiB encoded payload limit.
- Browser-scoped screenshot download endpoints.
- Docker and local development support.

### Browser Actions

- `tabs` operations for listing, navigating, focusing, and closing tabs.
- Bounded inactive new-tab creation through `tabs.navigate` without a `tid`.
- Real coordinate-based clicks through the Chromium Debugger API.
- Focused-control text entry, named keys, and modified keyboard shortcuts.
- Viewport and full-page PNG screenshots.
- Promise-aware, CSP-independent JavaScript evaluation.
- Bundled jQuery and Turndown helpers installed before JavaScript instructions
  under `window.__acob__`.

The JavaScript helpers make compact text, HTML, structured data, and Markdown
extraction practical today. They do not constitute the bounded semantic
inspection API planned below.

### Client And Integration

- An asynchronous Python client with typed action results and concurrent
  instruction support.
- Same-origin validation before screenshot downloads.
- Centralized extension settings with generated popup controls.
- Browser IDs generated and stored by each extension installation.
- Agent integration and safety guidance through `docs/SKILL.md`.
- Independent tooling and documentation under `client/`, `docs/`,
  `extension/`, `srv/`, and `web/`.

## Completed Milestones

### Transient Instructions

Status: implemented.

Instruction rows are transport state, not history. Pending and processing rows
remain available for polling. The first agent request that reads a terminal row
returns its response and conditionally deletes it. A later sequential read
returns `404 Instruction not found`.

This behavior remains supported until acknowledged transient delivery replaces
destructive terminal reads in the next milestone.

### Screenshots

Status: implemented.

The `screenshot` action targets a tab and supports viewport or full-page PNG
capture. Screenshot bytes cross the extension API as base64 and are stored in a
dedicated transient table. The completed instruction contains metadata and a
browser-scoped download URL, never the base64 payload.

A sequential download deletes the screenshot row before returning its bytes.
Later sequential downloads return 404. The current SQLite implementation does
not guarantee exclusive consumption by concurrent requests.

### Keyboard Input

Status: implemented.

The `keyboard` action targets the element that currently has keyboard focus and
supports Unicode text, named keys, single characters, and Alt, Ctrl, Meta, and
Shift modifiers. It does not change tab or window focus.

### Tab Navigation

Status: implemented.

`tabs.navigate` accepts a required URL and optional tab ID. With a tab ID it
navigates that tab; without one it creates a bounded inactive tab. `tabs.new`
is intentionally unsupported.

### JavaScript Extraction Helpers

Status: implemented, with follow-up work required.

Bundled jQuery and Turndown are loaded before each JavaScript instruction and
made available under a frozen page namespace. Follow-up work must add runtime
coverage, version the namespace, avoid unnecessarily replacing page globals,
and verify the packaged extension contains the required assets.

## Audited Gaps

The following gaps determine the milestone order:

- Compose publishes the unauthenticated development API on every host
  interface by default.
- Django's secret key, debug mode, and allowed hosts are hard-coded for
  development.
- A claimed instruction has no claim token, lease, attempt count, expiry, or
  recovery policy.
- Result retries exist only in service-worker memory and are lost on restart.
- Terminal results and screenshots are deleted before delivery is
  acknowledged.
- Concurrent result posts can overwrite each other and orphan screenshot rows.
- Concurrent screenshot requests can both receive supposedly single-use data.
- The extension does not serialize debugger-backed actions by tab.
- Request schemas are strict, but most result bodies are not validated for the
  action that produced them.
- Server and extension numeric and JSON constraints can disagree.
- There is no browser heartbeat, capability negotiation, cleanup process,
  health endpoint, structured lifecycle logging, or operational status view.
- Extension runtime behavior lacks automated Chromium integration coverage.
- There are no continuous-integration workflows or coordinated release tags.

## Next Milestone: Trustworthy Local Control

Status: next.

Goal: make local execution safe, observable, recoverable, and protocol-correct
before adding more browser authority.

### Safe Local Defaults

- Bind the Compose-published port to `127.0.0.1` by default.
- Move Django secret key, debug mode, and allowed hosts to environment-driven
  configuration with explicit development defaults.
- Add an optional bearer token shared by the server, extension, and Python
  client. Never use the browser ID as an authentication secret.
- Require JSON media types for JSON request endpoints.
- Add rate limits or local quotas for instruction creation and result posting.
- Add action-specific limits for URLs, selectors, keyboard text, scripts,
  errors, queue depth, and result size below Django's global request limit.
- Continue to document that a shared token does not make unencrypted remote
  deployment safe.

### Protocol Contracts

- Add a protocol version and capability metadata endpoint.
- Have the extension report its protocol version, package version, supported
  actions, operations, and configured limits.
- Prevent an extension from claiming work it does not support.
- Establish canonical request, result, and error contracts and generate shared
  documentation or OpenAPI output from them where practical.
- Validate tab IDs within JavaScript's safe-integer range across every
  component.
- Reject non-finite JSON values before persistence.
- Validate every successful result against its action-specific schema before
  making it terminal.
- Validate screenshot signatures and response content types, not only base64
  syntax.
- Replace unstructured error strings with bounded errors containing a stable
  code, message, execution phase, and retryability hint.
- Make Python client timeouts one monotonic end-to-end deadline covering
  submission, execution polling, and artifact download.

### Recoverable Instruction Lifecycle

- Accept a client-generated idempotency key when creating an instruction.
- Add claim tokens, lease deadlines, attempt counts, and expiry timestamps.
- Require the active claim token when completing an instruction.
- Make processing-to-terminal completion a conditional database transition so
  exactly one completion wins.
- Create screenshots or other artifacts only after completion ownership has
  been established.
- Persist unsent terminal results in a small `chrome.storage.local` outbox and
  retry them after a service-worker restart.
- Make terminal reads non-destructive and add explicit acknowledgment that
  deletes the result after successful client processing.
- Apply acknowledgment and expiry to screenshots and future artifacts.
- Guarantee exclusive artifact consumption or stop describing downloads as
  single-use.
- Add best-effort instruction cancellation with explicit `cancel_requested`,
  `canceled`, and `unknown_outcome` semantics.
- Never automatically replay potentially side-effecting work after an expired
  lease. Return `unknown_outcome` when execution may have occurred.
- Add cleanup for expired pending work, stale claims, unacknowledged results,
  orphaned artifacts, and abandoned browser queues.

Transient storage remains the default. Acknowledgment and short expiry improve
delivery reliability without creating durable history.

### Extension Reliability

- Add per-tab execution lanes for debugger-backed actions while preserving
  parallelism across independent tabs.
- Introduce a shared debugger broker if longer-lived trace sessions require
  one; otherwise keep attachment lifetimes minimal.
- Apply bounded timeouts to debugger attachment, CDP commands, Chrome API
  operations, and result delivery.
- Distinguish retryable network and server failures from permanent protocol
  failures.
- Add poll backoff and a reasonable minimum poll interval.
- Recover the offscreen polling document if it disappears.
- Persist only the minimum state needed to recover work after service-worker
  suspension or restart.
- Version and verify the injected page-library namespace.
- Stop replacing a site's `$`, `jQuery`, or `TurndownService` globals unless an
  explicit compatibility mode requires it.

### Browser Presence And Observability

- Add `/healthz` for server liveness without presenting it as browser
  readiness.
- Add extension heartbeat updates containing a user-defined browser label,
  versions, capabilities, pause state, and execution capacity.
- Add a browser status endpoint with server-stamped `last_seen`, computed
  online state, and queue counts.
- Add authenticated browser discovery only after token support exists.
- Add structured logs with instruction IDs, lifecycle transitions, durations,
  attempts, and sanitized failure details.
- Add a small local diagnostics view only if heartbeat, logs, and status APIs
  are insufficient. Do not restore consumed instruction history merely to
  build a dashboard.

### Quality And Release Infrastructure

- Add CI for server tests and checks, client tests and packaging, extension
  type checking, tests and production builds, and migration drift.
- Test concurrent claims, completions, terminal reads, artifact consumption,
  SQLite contention, lease expiry, cancellation, and lost responses.
- Add real Chromium integration coverage for polling, Chrome APIs, debugger
  actions, page-library injection, navigation, and worker recovery.
- Verify production builds contain jQuery, Turndown, source maps, declarations,
  styles, and manifest assets.
- Add missing package license metadata and ensure packaged license files exist.
- Add release tags and a changelog before the next external release.

### Acceptance Criteria

- Default Docker Compose usage is not reachable from other hosts.
- Token-enabled deployments reject unauthorized create, claim, result,
  download, status, and discovery requests without logging the token.
- Server and extension capabilities are checked before work is claimed.
- Concurrent claim, completion, terminal acknowledgment, and artifact tests
  establish a single winner.
- A service-worker restart does not silently discard an already produced
  result.
- Every instruction eventually reaches a terminal, canceled, expired, or
  explicitly unknown state.
- Potentially side-effecting work is never silently replayed.
- Debugger-backed actions on one tab are serialized; different tabs can still
  run concurrently.
- Server health and browser readiness are reported as distinct states.
- All component checks and production builds run in CI.

## Following Milestone: Semantic Browser Interaction

Status: planned after trustworthy local control.

Goal: give agents a compact, bounded, and deterministic page interface so
common work no longer requires bespoke JavaScript and fragile CSS selectors.

### Semantic Inspection

- Add an `inspect` action with bounded modes such as `interactive`, `content`,
  and `structured`.
- Return compact roles, accessible names, labels, state, bounds, frame context,
  and ephemeral element references for interactive controls.
- Return a document ID with every reference and reject references after
  navigation or document replacement with a structured `stale_element` error.
- Support bounded text or Markdown extraction under an explicit root.
- Support allowlisted attribute projection for structured extraction.
- Enforce maximum nodes, characters, depth, frames, attributes, and result
  bytes on both server and extension.
- Exclude password values, hidden secrets, event handlers, and arbitrary
  attributes by default.
- Treat inspected page content as untrusted input and preserve the prompt
  injection guidance in `SKILL.md`.
- Keep arbitrary JavaScript available for application-specific work that does
  not fit the constrained action.

### Deterministic Interaction

- Allow pointer and form actions to target either an existing CSS selector or
  an ephemeral semantic reference.
- Evolve `click` into bounded pointer operations such as click, double-click,
  hover, and drag without removing the current API prematurely.
- Add form operations for focus, fill, clear, select, check, and uncheck.
- Prefer real CDP pointer and keyboard behavior over direct DOM mutation.
- Return verification evidence such as target identity, focus state, selected
  option, checked state, and inserted character count without echoing secrets.
- Support frames and open shadow roots deliberately, with explicit limits and
  integration tests.

### User Control

- Add browser label, pause/resume, connection state, queue activity, and an
  execution badge to the extension popup.
- Add extension-owned origin allowlists and denylists.
- Gate arbitrary JavaScript separately because it can emulate most other
  actions.
- Add optional user confirmation for consequential actions and sensitive
  origins.
- Treat client-supplied intent as display-only context, never as authorization.
- Evaluate policy against the tab's actual URL at execution time and after
  redirects.
- Optionally pair semantic references with annotated screenshots for visual
  agents after the reference model is stable.

### Acceptance Criteria

- A typical inspect, target, act, and verify workflow requires no page-authored
  JavaScript.
- Repeated or generated CSS classes are not required for common interactions.
- Stale references fail explicitly and cause re-inspection rather than acting
  on an unintended element.
- Inspection output remains bounded on large, dynamic, framed, and shadow-DOM
  pages.
- Sensitive values are not returned or logged by default.
- Extension policy cannot be disabled by an API instruction.

## Later Milestone: Testing, Evidence, And Bounded Workflows

Status: conditional on the first two milestones.

Goal: support real-browser testing and lower-latency action groups without
turning ACOB into an unbounded recorder or workflow language.

### Browser Event Evidence

- Add bounded trace sessions for network metadata, console messages,
  JavaScript exceptions, navigation events, and dialogs.
- Default network capture to method, origin/path, resource type, status, and
  timing without request or response bodies.
- Redact authorization, cookies, credentials, token-like query parameters, and
  other known secrets before persistence.
- Enforce maximum duration, event count, event size, and total result size.
- Add explicit dialog acceptance, dismissal, and prompt input.
- Add focused performance and Core Web Vitals collection with typed results.

### Bounded Sequences

- Add same-tab composite instructions with a low maximum step count and total
  deadline.
- Return ordered per-step results and preserve the exact partial-completion
  state after an error or cancellation.
- Apply policy, validation, timeouts, and result limits to every step.
- Do not add loops, branches, nested sequences, rollback claims, or a generic
  expression language. The Python agent remains the orchestrator.

### Transient Artifacts And Files

- Generalize screenshot storage into an opaque transient artifact channel with
  media type, size, checksum, purpose, expiry, acknowledgment, and quotas.
- Use streaming temporary storage rather than placing large base64 values in
  SQLite.
- Add controlled file-input support through uploaded artifact IDs, never
  arbitrary server or client filesystem paths.
- Evaluate controlled browser download collection only after origin policy and
  artifact cleanup are established.
- Require explicit user policy or approval for file movement.

### Acceptance Criteria

- Tracing is bounded, redacted, short-lived, and disabled unless requested.
- A stopped or expired trace releases debugger resources reliably.
- Sequence failures report exactly which steps ran and never imply rollback.
- Artifact paths cannot escape managed temporary storage.
- Artifact count, bytes, and lifetime are bounded per browser.

## Conditional Candidates

These features require evidence that the simpler design is insufficient:

- Server-Sent Events or WebSockets, only after reliable lifecycle delivery is
  complete and polling latency is measured as a real bottleneck.
- Result callbacks or webhooks for integrations that cannot poll.
- Viewport, device, user-agent, locale, timezone, and geolocation emulation for
  explicitly isolated testing profiles.
- Snapshot deltas or DOM-change subscriptions after semantic inspection is
  stable.
- PostgreSQL, reverse-proxy TLS, and tenant isolation only if ACOB deliberately
  adopts remote multi-user deployment.
- Optional instruction history only if an audit requirement emerges, with
  transient operation remaining the default.

## Explicit Non-Goals

- Do not add a generic `scroll` action. Click already scrolls targets into
  view, and bounded JavaScript covers deliberate scrolling.
- Do not add a generic sleep or `wait` action. Agents can poll, and bounded
  JavaScript can check page-specific readiness.
- Do not provide general cookie export or mutation. It would expose HttpOnly
  credentials that the current page context cannot read. Reconsider only for a
  constrained, explicitly isolated testing mode.
- Do not synchronize browser IDs automatically through `chrome.storage.sync`.
  Two installations sharing one ID could split the same queue. Use explicit
  pairing, export/import, or identity recovery instead.
- Do not become a hosted browser farm or remote multi-tenant control plane by
  default.
- Do not retain durable instruction history by default.
- Do not build a general workflow language inside the extension.
- Do not allow unbounded DOM, network-body, console, screenshot, or artifact
  capture.
- Do not add stealth, CAPTCHA bypass, fingerprint evasion, or anti-bot features.
- Do not automate consequential purchases, messages, deletions, credential
  entry, or similar actions without explicit authorization and applicable
  extension policy.

## Recommended Implementation Order

1. Safe defaults, environment configuration, protocol metadata, strict result
   contracts, payload limits, and CI.
2. Conditional completion and artifact-consumption fixes with concurrency
   tests.
3. Per-tab execution lanes, bounded operations, and durable result outbox.
4. Leases, idempotency, acknowledgment, expiry cleanup, cancellation, and
   explicit unknown-outcome handling.
5. Browser heartbeat, labels, pause state, capability discovery, and structured
   observability.
6. Semantic inspection and ephemeral element references.
7. Deterministic form and pointer actions plus extension-owned origin policy.
8. Bounded traces, dialogs, performance evidence, sequences, and artifacts.

## Project Maintenance

- Keep the repository and all distributed packages under the MIT License.
- Keep root and component READMEs, `SKILL.md`, API schemas, extension behavior,
  client models, migrations, and tests synchronized for every action or
  lifecycle change.
- Add migration and compatibility notes whenever persisted transport state or
  protocol behavior changes.
- Keep browser IDs, tokens, cookies, page content, screenshots, and artifact
  data out of logs and test fixtures.
- Rebuild and inspect distributable artifacts before every release.
- Use release tags and a changelog once external releases are published.
- Revisit explicit non-goals only when a concrete user need and safe bounded
  design are documented.
