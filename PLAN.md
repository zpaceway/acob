# ACOB Product And Engineering Plan

This document defines ACOB's product direction, engineering constraints,
priorities, and release gates. ACOB is an active pre-release project. The plan
optimizes for trustworthy local browser control before expanding browser
authority or deployment scope.

## Product Direction

ACOB is a local-first execution plane for agents that operate a user's existing
Chromium session. The user chooses the browser profile and keeps its normal
authenticated state. A server coordinates bounded instructions, a Chromium
extension executes them, and typed Python and MCP interfaces expose the system
to controllers.

The intended product shape is:

- A user explicitly pairs a Chromium installation with a local controller.
- Controllers request typed, bounded browser operations.
- The extension evaluates local policy before touching a tab or page.
- Common workflows use semantic inspection and deterministic interactions.
- Real pointer and keyboard behavior remain available for browser fidelity.
- Arbitrary JavaScript is an explicitly enabled expert capability.
- Every accepted operation has a deadline and an honest terminal outcome.
- Results and artifacts remain transient, bounded, and locally controlled.
- Browser health and supported capabilities are known before work is accepted.
- Page content is always treated as untrusted data.

ACOB is not a hosted browser farm, a stealth automation framework, or a general
workflow language.

## System Baseline

```text
Python client or MCP host
    -> Django instruction API
    -> browser-scoped SQLite queue
    -> polling Manifest V3 extension
    -> Chrome tabs APIs and Chromium DevTools Protocol
    -> structured result or transient screenshot
```

### Server

- Strict Pydantic request models reject unknown fields and coercion.
- Browser queues are scoped by lowercase dashless UUIDv4 identifiers.
- Instructions move through `pending`, `processing`, `completed`, and `failed`.
- Claims use conditional pending-to-processing updates and bounded batches.
- Completions use conditional processing-to-terminal updates.
- Terminal instruction responses are consumed on the first terminal read.
- Screenshots use browser-scoped download records that are deleted when served.
- Screenshot payloads and scroll results receive action-specific validation.
- Extension recovery uses a dedicated command and acknowledgement channel.
- Local development and container workflows use Django, SQLite, and Uvicorn.

### Extension

- The service worker polls through an offscreen document.
- Configuration, browser identity, and recovery state use local extension
  storage.
- Supported actions are `list`, `navigate`, `focus`, `close`, `reload`,
  `scroll`, `click`, `keyboard`, `screenshot`, and `javascript`.
- Targeted operations are serialized per tab while different tabs can run
  concurrently.
- New-tab creation is serialized and bounded by the configured tab limit.
- Click and keyboard actions use CDP input commands.
- Screenshots use `Page.captureScreenshot`.
- JavaScript evaluation awaits promises and returns JSON-compatible values or
  explicit representations for Chromium unserializable values.
- jQuery and Turndown are bundled for page extraction under
  `window.__acob__`.
- JavaScript execution has a hard timeout, CDP termination, and tab reload.
- Extension reinstall stops tracked JavaScript, reloads affected tabs, restarts
  the worker, and acknowledges startup.
- Centralized settings define polling, capacity, tab, timeout, screenshot, and
  retry limits.

### Python Client

- `ACOBClient` provides asynchronous high-level action methods.
- `submit()`, `wait()`, and `execute()` expose the queue lifecycle directly.
- Structured results use strict Pydantic models.
- Connection, HTTP, protocol, instruction, and timeout failures have dedicated
  exception types.
- Independent operations and waits can run concurrently in one event loop.
- Screenshot downloads are constrained to the configured server origin.
- Extension reinstall uses the recovery channel.

### MCP Adapter

- One MCP process targets one configured browser.
- Stdio and stateless Streamable HTTP transports are supported.
- Tool schemas are derived from typed functions and reject unknown arguments.
- The tool set mirrors the high-level Python client action set.
- Screenshots are returned as MCP PNG image content.
- Server instructions emphasize tab discovery, untrusted page content,
  side-effect awareness, and preservation of unrelated browser state.
- HTTP transport applies Host and Origin allowlists.

### Repository And Tooling

- Server, client, MCP, extension, and website are independently owned
  components.
- Python components use Ruff, Black, Pyright, and component-specific tests.
- The server also uses mypy, Django checks, and migration drift checks.
- The extension uses strict TypeScript, unit tests, and a production build.
- The website is a buildless static project with manual verification guidance.

## Engineering Principles

- Safe local operation is the default configuration.
- Browser IDs, tab IDs, operation IDs, and element references are routing
  identifiers, not credentials.
- Controller, executor, and operator authority are separate.
- Extension-owned policy cannot be relaxed by an instruction.
- GET requests are observational and repeatable.
- Common browser work uses typed semantic actions.
- JavaScript is a privileged escape hatch with broad page authority.
- Inputs, outputs, queues, artifacts, traces, retries, and lifetimes are bounded.
- One deadline covers submission, queueing, execution, result delivery, and
  artifact retrieval.
- Unknown outcomes are represented explicitly.
- Submission idempotency prevents duplicate queue entries but does not promise
  exactly-once browser side effects.
- Same-tab work remains ordered; browser-global resources use explicit lanes.
- Accessibility semantics are part of the targeting model.
- Stale element references fail without retargeting another node.
- Sensitive values are omitted from results, logs, traces, and diagnostics by
  default.
- Observability is opt-in, redacted, bounded, local, and visibly active.
- A feature is complete only when protocol, server, extension, client, MCP,
  tests, and documentation agree.
- Public capability claims require automated coverage or a clearly identified
  manual verification procedure.

## Core Invariants

1. Every non-liveness API route requires authenticated, scoped authority.
2. A controller cannot impersonate an extension executor.
3. An executor cannot create controller instructions.
4. Every accepted operation reaches a terminal, canceled, expired, or
   `unknown_outcome` state within a finite time.
5. Potentially side-effecting work is never replayed automatically after an
   uncertain execution boundary.
6. Claims require an active token, executor session, and unexpired lease.
7. Terminal results and artifacts remain readable until acknowledgement or
   expiry.
8. Completion and acknowledgement are idempotent for the same token and digest.
9. Operations affecting one tab execute in order.
10. Browser focus, tab creation, and debugger observation use explicit shared
    resource lanes.
11. Cancellation distinguishes work that never started, work stopped safely,
    and work with an uncertain effect.
12. Element references are scoped to browser session, tab, frame, and document.
13. Document replacement, frame navigation, tab closure, or node detachment
    invalidates affected references.
14. Password values, authorization data, cookies, and file contents are never
    returned or logged by default.
15. Policy is evaluated against actual top-level and frame URLs at execution
    time and after redirects.
16. Every action has strict request, success, and error schemas.
17. Every numeric value is finite and every text or binary value has a byte
    limit.
18. Debugger attachments and trace sessions have bounded duration and
    deterministic cleanup.
19. External telemetry is disabled unless the user explicitly configures it.

## Priority Gaps

| Priority | Gap | Consequence |
| --- | --- | --- |
| P0 | No API authentication or role separation | Any network caller that reaches the server can request browser actions. |
| P0 | Development network and Django defaults | Debug responses, an embedded secret, broad hosts, and all-interface publication are unsafe outside a trusted workstation. |
| P0 | GET routes claim or consume state | Retries, previews, concurrent readers, and interrupted transfers can mutate or lose data. |
| P0 | No claim leases, cancellation, acknowledgement, or expiry | Processing work can remain stuck and terminal delivery can be lost. |
| P0 | No durable extension result outbox | A worker restart can lose an executed result. |
| P0 | Ambiguous outcomes after execution or recovery failures | A failed status can hide a browser effect that already happened. |
| P0 | Partial timeout coverage | Chrome APIs, debugger operations, result delivery, and client phases can exceed the requested deadline. |
| P0 | Incomplete result validation | Most action completions accept arbitrary JSON at the server boundary. |
| P0 | Missing input, result, queue, and error limits | Large requests or aggressive settings can exhaust local resources. |
| P0 | No real-Chromium integration suite or CI | Browser behavior, worker recovery, packaging, and interoperability are not continuously verified. |
| P1 | No browser heartbeat or capability handshake | Controllers can enqueue work for an offline or incompatible browser. |
| P1 | Per-tab backlog consumes global capacity | Repeated work for one tab can delay independent tabs. |
| P1 | Browser-global focus can race across tab lanes | Concurrent focus actions can produce nondeterministic user-visible state. |
| P1 | No extension-owned origin or action policy | Broad host and debugger authority has no local allowlist, pause, or approval gate. |
| P1 | No semantic page model or stable references | Agents depend on screenshots, selectors, and arbitrary JavaScript. |
| P1 | No deterministic forms, waits, or dialog handling | Common workflows require fragile sequencing and page-specific code. |
| P1 | Page helper injection writes page globals | Library setup can interfere with application-owned names. |
| P1 | No bounded console, network, or navigation evidence | Failures are difficult to explain without arbitrary scripts or external tools. |
| P1 | Screenshot storage is not a general artifact channel | Binary data is copied through JSON and SQLite without acknowledgement or checksums. |
| P1 | No managed upload or download model | File movement has no policy, quota, lifecycle, or safe path abstraction. |
| P2 | Version and artifact verification is manual | Packages and generated artifacts can drift from source contracts. |
| P2 | Website behavior has no automated checks | Accessibility, keyboard interaction, links, and product claims can regress. |

## Protocol Model

The protocol should have one language-neutral definition with shared valid and
invalid fixtures. JSON Schema is the initial interchange format. Generated
bindings are useful only when generation reduces maintenance across Python,
TypeScript, client, and MCP code.

An instruction envelope should contain:

```text
instruction_id
request_id
idempotency_key
browser_id
browser_session_id
action
parameters
created_at
deadline_at
policy_context
```

A claim should contain:

```text
claim_id
executor_session_id
lease_expires_at
attempt
execution_lane
```

A terminal envelope should contain:

```text
outcome
result | error
effect_phase
started_at
completed_at
artifacts
result_digest
acknowledged_at
```

Errors should contain a stable `code`, bounded `message`, execution `phase`,
`retryable` flag, `outcome`, and bounded structured `details`. Initial codes
should cover invalid input, authentication, browser availability, policy,
missing tabs, changed documents, stale references, ambiguous targets,
interactability, dialogs, deadlines, cancellation, debugger ownership,
artifact expiry, and unknown outcomes.

## Milestone 0: Verified Foundation

**Goal:** establish one bounded protocol and continuously verify the complete
local execution path.

### Work

- Add canonical action request, success, and error schemas.
- Add shared conformance fixtures for every action and invalid input class.
- Define JavaScript-safe numeric bounds across all components.
- Bound URLs, selectors, scripts, keyboard text, errors, results, queue depth,
  and configurable concurrency.
- Require JSON media types on JSON routes.
- Validate PNG signatures, decoded size, dimensions, and response media type.
- Add structured errors with stable codes and retryability.
- Add CI for formatting, linting, typing, tests, migration checks, package
  builds, extension builds, container builds, and documentation links.
- Add a deterministic local fixture site and real-Chromium smoke suite.
- Exercise every browser action through server, extension, and client.
- Exercise MCP stdio against the same runtime.
- Add fault injection for server outages, tab closure, debugger conflicts,
  worker restart, and lost result responses.
- Add automated HTML, link, accessibility, and keyboard checks for the website.

### Acceptance

- Every action accepts and rejects the same fixtures in Python and TypeScript.
- Unsupported fields fail before enqueueing.
- Every configured number has safe lower and upper bounds.
- A real Chromium test lists, navigates, scrolls, clicks, types, reloads,
  captures a screenshot, and evaluates bounded JavaScript.
- A worker restart test produces an explicit, explainable result.
- Package and container smoke tests run from clean environments.
- Documentation links and advertised capabilities pass automated checks.

## Milestone 1: Secure Local Control

**Goal:** make local deployment safe by default and put browser authority under
user-owned policy.

### Work

- Add controller, executor, and operator credentials with distinct scopes.
- Bind executor credentials to browser identity and session.
- Add one-time local pairing, credential rotation, and revocation.
- Add scoped credential configuration to the Python client and MCP adapter
  without embedding credentials in endpoint URLs.
- Keep credentials out of URLs, logs, page data, and diagnostics.
- Require independent authentication for MCP Streamable HTTP.
- Bind server and MCP containers to loopback by default.
- Add validated environment settings for secret key, debug mode, hosts, data
  directory, and trusted proxies.
- Refuse unsafe plaintext network configurations unless explicitly enabled.
- Add endpoint body limits, queue quotas, rate limits, and content-type checks.
- Add extension origin allowlists and denylists.
- Add action classes for inspection, navigation, input, scripts, files,
  observation, and administration.
- Add user-controlled pause, emergency stop, and approval requirements.
- Evaluate policy for top-level and target-frame URLs after redirects.
- Gate arbitrary JavaScript separately from ordinary interactions.
- Run helper libraries in an isolated, versioned world without overwriting
  page-owned globals.
- Publish a threat model for malicious pages, prompt injection, local callers,
  stale workers, credentials, file movement, and browser-session exposure.

### Acceptance

- Every queue, claim, result, artifact, status, and recovery route enforces the
  correct role.
- Missing, expired, revoked, or incorrectly scoped credentials fail safely.
- Default containers are reachable only from the local host.
- Extension policy cannot be weakened by an instruction payload.
- Pause prevents new claims and exposes a clear status.
- Policy-denied actions never attach the debugger or send browser input.
- Sensitive tokens never appear in access logs, errors, fixtures, or page data.
- The release configuration passes its declared Django deployment checks.

## Milestone 2: Reliable Operation Lifecycle

**Goal:** ensure accepted work cannot disappear, remain stuck indefinitely, or
report more certainty than the runtime has.

The lifecycle target is:

```text
queued
  -> claimed
  -> running
  -> succeeded | failed | canceled | expired | unknown_outcome
  -> acknowledged | expired
```

### Work

- Accept controller-generated idempotency keys.
- Return the same instruction for matching browser, action, parameters, and
  idempotency key.
- Reject idempotency-key reuse with different content.
- Make GET routes observational and move claiming, consumption,
  acknowledgement, cancellation, and deletion to explicit mutation routes.
- Issue claim tokens, executor sessions, lease deadlines, and attempt numbers.
- Require the claim token for start, renewal, completion, and cancellation.
- Make completion idempotent for the same result digest.
- Keep terminal results readable until acknowledgement or expiry.
- Add idempotent result and artifact acknowledgement.
- Introduce a transient artifact channel for screenshots, traces, and other
  binary results.
- Store artifact media type, size, checksum, purpose, owner, expiry, and
  acknowledgement state in metadata.
- Stream artifact bytes through managed local storage and keep reads repeatable
  until acknowledgement or expiry.
- Persist produced results in an extension IndexedDB outbox before delivery.
- Retry transient delivery failures with bounded exponential backoff and
  jitter.
- Classify authentication, validation, policy, and claim failures as permanent.
- Add queued cancellation and active cancellation requests.
- Record whether an effect was avoided, stopped, completed, or became unknown.
- Propagate one absolute protocol deadline across processes and enforce the
  remaining budget with a local monotonic clock in each component.
- Bound debugger attach, each CDP command, detach, Chrome API calls, and final
  result submission.
- Add browser heartbeat, session epoch, last-seen state, and capability data.
- Add server liveness, readiness, browser status, and capability endpoints.
- Add fair lane-aware claiming so one tab cannot occupy every execution slot.
- Add a browser-focus lane and keep tab creation serialized.
- Add deterministic cleanup for expired queue, result, recovery, and artifact
  state.
- Expose operation status, cancellation, acknowledgement, and deadline behavior
  through the Python client and MCP adapter.

### Acceptance

- Lost create responses do not duplicate work with the same idempotency key.
- GET requests cannot claim, consume, acknowledge, cancel, or delete state.
- Service-worker restart after result production does not lose the result.
- Lost completion and acknowledgement responses can be retried safely.
- Results and artifacts can be fetched repeatedly before acknowledgement.
- No processing lease remains active indefinitely.
- Potentially side-effecting work is never silently replayed.
- Queued cancellation guarantees that browser execution never starts.
- Active cancellation reports avoided, stopped, completed, or uncertain effect.
- Client and MCP deadlines exceed requested duration only by bounded cleanup.
- Same-tab work stays ordered while independent tabs use available capacity.
- Concurrent focus requests execute in deterministic order.
- Browser readiness becomes false within the documented heartbeat interval.
- Liveness, readiness, and browser capability endpoints report distinct states.

## Milestone 3: Semantic Inspection

**Goal:** let agents understand and target pages without fragile generated
selectors or arbitrary page-authored scripts.

### Work

- Add bounded `inspect` modes for interactive controls, readable content, and
  accessibility structure.
- Build inspection from CDP DOM snapshot and Accessibility data.
- Return document identity, frame identity, URL origin, title, readiness, and
  truncation metadata.
- Represent nodes with opaque reference, role, accessible name, label, type,
  state, bounds, visibility, interactability, frame, and concise text.
- Include disabled, checked, pressed, expanded, selected, required, invalid,
  readonly, focused, and editable states where applicable.
- Omit password values, hidden values, event attributes, and arbitrary data
  attributes by default.
- Support explicitly allowlisted attribute projection.
- Bound node count, depth, frames, text, attributes, per-node size, and total
  result bytes.
- Scope references to browser session, tab, frame, and document.
- Resolve references with document and backend-node identity.
- Reject references after navigation, frame replacement, tab closure, browser
  restart, or node detachment.
- Add strict semantic locators by role and accessible name.
- Return bounded candidate summaries for ambiguous locators.
- Support open shadow roots and same-origin frames.
- Report unsupported frame contexts explicitly.
- Add bounded text and Markdown extraction under a selected semantic root.

### Acceptance

- Agents can identify buttons, links, inputs, checkboxes, radios, selects, and
  content regions without generated CSS classes.
- DOM sibling reordering does not invalidate an attached reference.
- Document replacement invalidates references immediately.
- Detached controls return `stale_reference` and never retarget replacements.
- Large pages remain within configured node, frame, text, and byte limits.
- Password and hidden secret values do not appear in inspection, logs, errors,
  or snapshots.
- Duplicate semantic targets fail as ambiguous without strict context.
- Inspection remains useful when arbitrary JavaScript is disabled.

## Milestone 4: Deterministic Interaction

**Goal:** provide reliable forms, pointer input, navigation synchronization, and
dialog handling with verifiable outcomes.

Target arguments should accept exactly one of:

```text
opaque element reference
strict semantic locator
strict CSS selector
```

### Work

- Introduce a per-tab debugger broker with serialized commands and bounded
  event subscriptions for action synchronization and dialogs.
- Make CSS targeting fail when zero or multiple elements match.
- Add typed `focus_element`, `fill`, `clear`, `select`, `check`, `uncheck`, and
  `press` actions for page controls.
- Verify target document, visibility, enabled state, editability, bounds, focus,
  and hit target before input.
- Use real CDP input where browser fidelity matters.
- Use narrowly defined DOM operations for native controls when real input
  cannot express a reliable state change.
- Return the execution mode and observed final state.
- Support native inputs, textareas, contenteditable, select controls, and
  common controlled-input frameworks.
- Reject password entry by default.
- Add short-lived secret handles before allowing sensitive values.
- Add hover and double-click after ordinary click invariants are covered.
- Gate drag-and-drop on reliable pointer sequencing and cancellation tests.
- Add waits for attachment, visibility, enabled state, focus, checked state,
  selected value, text, URL, document readiness, navigation commit, and bounded
  network quiescence.
- Add action-and-wait operations for navigation-triggering interactions.
- Implement waits with browser events or observers plus bounded fallback
  polling.
- Add typed alert, confirm, prompt, and before-unload state.
- Require explicit dialog acceptance or dismissal.
- Return observed post-action evidence without echoing sensitive values.

### Acceptance

- A representative form can be inspected, filled, selected, checked,
  submitted, and verified without arbitrary JavaScript.
- Tests cover native controls, contenteditable, controlled inputs, disabled
  fields, hidden fields, validation errors, and duplicate labels.
- Text entry fails when focus or editability cannot be verified.
- State-setting actions are safe to repeat when the requested state is present.
- Click fails before dispatch when another element owns the target point.
- Navigation-triggering actions cannot miss the resulting document change.
- Waits terminate on success, cancellation, tab closure, document replacement,
  or deadline.
- Dialogs never receive an implicit affirmative response.

## Milestone 5: Bounded Browser Evidence

**Goal:** provide enough local evidence to explain browser behavior without
becoming a general traffic recorder or DevTools replacement.

### Work

- Extend the per-tab debugger broker with bounded trace subscriptions.
- Return a stable error when user DevTools or another debugger owns the tab.
- Add trace sessions with maximum duration, events, event size, and total bytes.
- Capture navigation lifecycle, network metadata, console messages, JavaScript
  exceptions, page crashes, and dialog events.
- Capture method, sanitized origin and path, resource type, status, timing,
  cache state, and failure reason for network evidence.
- Exclude request and response bodies by default.
- Remove fragments, sensitive query values, cookies, authorization, and token
  headers.
- Bound console text and object previews without invoking page getters.
- Redact configured secret patterns before persistence.
- Store larger trace output through the transient artifact channel.
- Show an active-recording indicator and trace state in the popup.
- Stop traces on deadline, cancellation, tab closure, debugger loss, policy
  denial, worker restart, or explicit stop.

### Acceptance

- A bounded trace surrounds an inspect-act-wait flow and returns ordered
  navigation, network, console, exception, and dialog evidence.
- Default traces contain no bodies, cookies, authorization, or raw secret query
  values.
- Event and byte limits are enforced in extension and server.
- Every stop path releases debugger ownership.
- Debugger conflicts return a stable result without hanging.
- The popup visibly indicates observation activity.

## Milestone 6: Artifacts And Files

**Goal:** support deliberate, policy-controlled file movement through managed
artifacts without exposing arbitrary filesystem paths.

### Work

- Extend the transient artifact channel to controller uploads and
  browser-produced files.
- Enforce per-file, per-browser, and total quotas.
- Sanitize display filenames and use generated storage names.
- Add `set_files` for inspected file inputs using artifact IDs.
- Validate target type, `accept`, `multiple`, file count, policy, and approval.
- Prototype browser-side in-memory `File` and `DataTransfer` construction.
- Add download start, progress, completion, interruption, filename, media type,
  origin, size, and checksum evidence.
- Add `wait_for_download` before exposing byte collection.
- Timebox a CDP stream prototype for authenticated and generated downloads.
- Enable download bytes only when cleanup, cancellation, redirect handling, and
  checksums are reliable.
- Require visible user policy for upload and download content movement.

### Acceptance

- Artifact IDs cannot access another browser's data.
- Filenames cannot escape managed storage.
- Interrupted transfers clean up partial state.
- Expired or acknowledged artifacts become unavailable and are deleted.
- File inputs receive only approved managed artifacts.
- Count, media type, extension, and size restrictions are enforced before
  browser transfer.
- Download evidence covers ordinary, redirected, interrupted, and denied flows.
- No API returns an absolute browser, server, or client filesystem path.

## Milestone 7: Product Surfaces And Release Readiness

**Goal:** expose the reliable semantic runtime consistently through Python,
MCP, documentation, containers, and release artifacts.

### Work

- Stabilize typed client operation handles and add artifact streaming helpers.
- Stabilize credential configuration, redaction, and documentation across
  client and MCP surfaces.
- Validate media types, checksums, structured errors, and capability metadata.
- Retry only requests proven safe by lifecycle and idempotency state.
- Keep `Any` limited to explicitly arbitrary JavaScript results.
- Expose browser readiness, capabilities, policy, pause state, and active lanes.
- Add MCP progress for waits, uploads, downloads, and traces.
- Generate MCP annotations from action metadata.
- Gate tool availability by browser capability and extension policy.
- Keep large artifacts outside normal MCP message bodies.
- Add a capability and security-boundary matrix to user documentation.
- Keep website claims tied to accepted and tested capabilities.
- Complete keyboard tab behavior, mobile-menu focus handling, Escape behavior,
  ARIA relationships, and automated accessibility checks.
- Add coordinated version checks and reproducible release artifacts.
- Add checksums, dependency inventories, and clean-install smoke tests.
- Run server containers as a non-root user with persistent data and health
  checks.

### Acceptance

- Python and MCP receive identical outcomes and error codes for equivalent
  actions.
- Client, MCP, server, and extension cancellation share lifecycle semantics.
- Disabled capabilities are not presented as usable tools.
- MCP annotations match each action's mutation and retry behavior.
- Large artifacts stay within host message limits.
- Fresh-install tests cover server, extension, Python client, MCP stdio, MCP
  HTTP, and static site deployment.
- Documentation contains no capability claim without matching verification.
- Supported runtime versions match the CI matrix.

## Test Strategy

| Layer | Required Coverage |
| --- | --- |
| Protocol | Golden valid and invalid fixtures, finite numbers, unknown fields, size limits, and cross-language conformance. |
| Server | Concurrent claims, leases, completion, acknowledgement, cancellation, expiry, cleanup, quotas, and SQLite contention with separate connections. |
| Extension unit | Injectable Chrome and CDP adapters, lane scheduling, outbox, backoff, policy, references, redaction, deadlines, and error classification. |
| Chromium integration | Every action, real pointer and keyboard behavior, semantic inspection, frames, shadow roots, dialogs, traces, files, and worker restart. |
| Failure injection | Lost responses, server outage, worker suspension, browser restart, tab closure, navigation, debugger conflict, lease expiry, and interrupted artifacts. |
| Client integration | Authentication, deadlines, cancellation, result acknowledgement, media types, checksums, and artifact retries against a real server. |
| MCP integration | Stdio and HTTP authentication, cancellation, progress, capability-gated tools, annotations, image limits, and structured errors. |
| Security | Role enforcement, token redaction, host validation, content types, origin policy, private-network rules, path traversal, and secret leakage. |
| Accessibility | Semantic roles and names, focus order, keyboard workflows, missing-name diagnostics, and website checks. |
| Packaging | Wheel and source contents, extension archive, container user and health, licenses, lockfile reproducibility, and clean installs. |

Chromium tests should use local fixture pages for forms, navigation, popups,
frames, shadow DOM, downloads, console messages, network failures,
accessibility, and prompt-injection content. CI must not depend on external
websites.

## Operational Signals

- Server liveness is independent from browser readiness.
- Browser status includes last-seen time, session epoch, compatibility, pause
  state, capacity, busy lanes, and supported capabilities.
- Queue status includes depth, oldest age, claim delay, execution duration,
  delivery duration, retries, lease expiry, cancellation, unknown outcomes,
  policy denial, and artifact cleanup.
- Logs use correlation IDs and stable error codes.
- Logs omit page text, scripts, selectors, keyboard text, credentials, file
  content, and sensitive URL data by default.
- Metrics remain local and bounded.
- Diagnostics export versions, capability metadata, sanitized lifecycle events,
  and configuration names without secrets or page data.

## Packaging Scope

| Component | Direction |
| --- | --- |
| Server | Hardened container and source-checkout workflow. |
| Python client | Wheel and source distribution with typed metadata and clean-install tests. |
| MCP adapter | Wheel and non-root container with authenticated HTTP defaults. |
| Extension | Reproducible unpacked directory and deterministic archive with checksums. |
| Protocol | Repository-owned schemas and fixtures, published when external implementers need them. |
| Website | Static deployment without a package registry artifact. |

A root task runner should execute component checks, builds, protocol
conformance, and smoke tests without introducing a root runtime dependency
graph.

## Non-Goals

- Hosted multi-tenant browser infrastructure.
- Internet exposure by default.
- Exactly-once browser side effects.
- Automatic replay of uncertain clicks, keys, submissions, navigation, or
  JavaScript.
- Durable browsing or instruction history by default.
- A workflow language with loops, branches, variables, or rollback claims.
- Arbitrary sleep as a synchronization primitive.
- Element references that survive document replacement.
- Unbounded DOM, accessibility, screenshot, console, network, trace, or file
  capture.
- Request or response bodies in default network traces.
- Cookie export, credential extraction, profile export, or password discovery.
- Arbitrary server, browser, or client filesystem paths.
- Silent file uploads or downloads.
- Stealth, CAPTCHA bypass, fingerprint evasion, or anti-bot behavior.
- Consequential purchases, messages, deletions, or credential entry without
  explicit authorization and applicable local policy.
- A full DevTools replacement.
- Cross-browser expansion before the Chromium runtime reaches release quality.
- Publishing every repository component to a package registry.

## Release Gates

### Foundation Preview

- Milestones 0 through 2 meet their acceptance criteria.
- The action set is authenticated, bounded, recoverable, cancellation-aware,
  and observable through health endpoints.
- Arbitrary JavaScript and operator recovery require explicit enablement.
- No open P0 security, lifecycle, or contract issue remains.

### Agent Preview

- Milestones 3 and 4 meet their acceptance criteria.
- Typical inspect-target-act-wait workflows need neither generated CSS classes
  nor arbitrary JavaScript.
- Stable references, forms, dialogs, accessibility semantics, and local policy
  pass Chromium integration tests.

### Evidence Preview

- Milestone 5 meets its acceptance criteria.
- Network and console evidence is bounded, redacted, visibly active, and
  reliably cleaned up.
- Trace capture cannot silently retain debugger ownership or sensitive bodies.

### Files Preview

- Milestone 6 meets its acceptance criteria.
- Uploads and downloads are policy-controlled, transient, path-safe,
  quota-bound, and covered by authenticated browser fixtures.
- Download byte collection remains unavailable unless safe capture is proven.

### Release Readiness

- Milestone 7 meets its acceptance criteria.
- All component checks and browser suites run in CI.
- Security review covers pairing, authentication, policy, traces, files, and
  MCP HTTP.
- Default containers bind safely, run non-root, persist intended data, and
  report health.
- Every action documents its request, result, error, deadline, cancellation,
  and retry contract.
- No accepted operation can remain permanently unexplained.
- Browser mutations never report a safely failed outcome when effects may have
  occurred.
- Package contents, licenses, versions, checksums, and clean-install workflows
  are verified.
- Documentation and website claims match tested capability gates.
- Manual exploratory testing covers every supported operating system with a
  dedicated Chromium profile.

## Recommended Implementation Order

1. Canonical schemas, shared fixtures, structured errors, and comprehensive
   limits.
2. CI and a real-Chromium end-to-end harness.
3. Controller, executor, and operator authentication, safe network defaults,
   extension origin and action policy, approvals, and emergency stop.
4. Read-only GET routes and explicit claim, completion, acknowledgement, and
   cancellation mutations.
5. Idempotency keys, claim leases, durable result outbox, transient artifacts,
   and cleanup.
6. End-to-end deadlines across server, extension, client, and MCP.
7. Browser heartbeat, capability negotiation, pause state, and fair lane-aware
   claiming.
8. Semantic inspection, document identity, accessibility data, and stable
   references.
9. Deterministic forms, pointer actions, waits, navigation synchronization, and
   dialogs.
10. Debugger trace subscriptions and bounded network, console, and navigation
    evidence.
11. Managed uploads and download evidence, with byte capture gated by tests.
12. Client, MCP, website, packaging, and release workflows aligned with the
    tested capability model.

Lifecycle correctness, authentication, policy, and browser integration coverage
are prerequisites for semantic authority, tracing, and file movement.
