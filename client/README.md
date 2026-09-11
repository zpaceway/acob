# ACOB Python Client

The ACOB Python client asynchronously controls the Chromium extension connected
to one local ACOB stack and its global instruction queue. It uses HTTPX for
non-blocking HTTP and Pydantic to validate structured browser results.

It requires Python 3.10 or newer. Install it from this directory:

```bash
python -m pip install .
```

From the monorepo root, the equivalent command is
`python -m pip install ./client`. The [server](../srv/README.md) and
[Chromium extension](../extension/README.md) must also be running to execute
browser instructions.

All operations that communicate with ACOB are awaitable. The endpoint is
optional, so the default local proxy can be used with no constructor arguments:

```python
import asyncio

from acob import ACOBClient


async def main() -> None:
    async with ACOBClient() as client:
        tabs = await client.list()
        tab = await client.navigate("https://example.com")
        tid = tab.tid

        await client.scroll(tid, 500)
        await client.click(tid, "a")
        await client.wait_for_selector(tid, "a")
        await client.keyboard(tid, text="ACOB")
        await client.keyboard(tid, key="Enter")
        title = await client.javascript(tid, "document.title")

        screenshot = await client.screenshot(tid, full_page=True)
        print(screenshot.url)

        recording = await client.record("start", tid)
        await asyncio.sleep(10)
        video = await client.record("stop", tid)
        print(video.url, video.stopped_reason)

        proxied = await client.proxy("set", proxy="socks5://127.0.0.1:1080")
        print(proxied.scheme, proxied.host, proxied.port)
        await client.proxy("unset")

        cleaned = await client.cleanup()
        print(cleaned.cleaned)


asyncio.run(main())
```

The endpoint defaults to the unified proxy at `http://127.0.0.1:58346`.
`ACOBClient` selects a stack only by endpoint; per-browser targeting is the
optional `bid` argument on every action call (32 lowercase hex,
`^[0-9a-f]{32}$`, validated client-side — copy it from the extension popup's
read-only Browser ID field). Configure a different stack and result-wait deadline when
needed:

```python
client = ACOBClient(
    endpoint="http://127.0.0.1:8000",
    timeout=90,
    poll_interval=0.5,
)
try:
    tabs = await client.list()
finally:
    await client.aclose()
```

Root installations require `ACOB_APPLICATION_NAME` and always use context
`acob-<port>-<name>` for the Compose project, network, volume, container, and
image resource prefix, managed browser, and default MCP registration label. For
example, `make install ACOB_PROXY_PORT=61554 ACOB_APPLICATION_NAME=alexandro` creates context
`acob-61554-alexandro`. Names allow
lowercase letters, digits, and internal hyphens and cannot start or end with a
hyphen. Use the same `ACOB_PROXY_PORT` and `ACOB_APPLICATION_NAME` for lifecycle commands, and use a distinct
port for every installation because only one process can bind it. `ACOBClient`
still selects only by endpoint; a context name adds no protocol routing beyond
the per-call `bid` target, and untargeted work on each selected stack remains
claimable by any connected browser.

`timeout` is the default result-wait deadline after submission and also caps
individual HTTP requests. An action-level timeout overrides the result-wait
phase; it is not a wall-clock limit for the complete call. `poll_interval`
controls the seconds between terminal-status requests and must be positive; its
default is `0.5`.

Keep a client within one event loop. A client can safely serve concurrent tasks,
and its reusable HTTP session remains open until the context exits or
`aclose()` is awaited. A closed client cannot be reused.

## API Documentation

Use `await client.api()` to read an `ApiDocumentation` model containing the
API origin, Swagger and OpenAPI URLs, instruction/batch URLs, a polling URL
template and a usage guide. This performs only `GET /api/` and works without
a polling extension. The returned links follow the API request's host and port.

## Parallel Execution

Independent actions can be submitted and polled concurrently with
`asyncio.gather()`, so long-running work on independent tabs can overlap:

```python
first_tab, second_tab = await asyncio.gather(
    client.navigate("https://example.com/first"),
    client.navigate("https://example.com/second"),
)

first_title, second_title = await asyncio.gather(
    client.javascript(first_tab.tid, "document.title"),
    client.javascript(second_tab.tid, "document.title"),
)
```

Only parallelize operations that are independent. Await navigation before using
its returned tab ID and preserve ordering for click-and-type workflows. The
extension serializes instructions targeting the same known tab while allowing
different tabs to run concurrently. Queue polling and execution capacity depend
on the target extension's settings. Larger batches may remain queued and reach
their client timeout.
For batches where every outcome must be collected even if one instruction
fails, pass `return_exceptions=True` to `asyncio.gather()` and inspect each
result.

Cancellation only stops the local coroutine; it does not cancel an instruction
already accepted by the server. Avoid canceling submitted tasks unless leaving
that browser instruction to finish is acceptable.

## Actions And Results

Action methods map directly to API actions and payload fields. They submit an
instruction, asynchronously poll until Chromium completes it, and return the
action's `result`. Every method (plus `submit`/`execute` and
`submit_batch`/`execute_batch`) accepts optional `bid=` to target one browser;
omit it for untargeted work claimable by any browser. Every response model
carries the instruction's `bid` (the target while pending, the executor after
completion; `None` when untargeted) — read it on the result (e.g. `tab.bid`,
`screenshot.bid`):

```python
tab = await client.navigate(
    "https://example.com", bid="0123456789abcdef0123456789abcdef"
)
tabs = await client.list()  # untargeted; any connected browser may claim it
print(tab.bid)
```

Structured results are validated Pydantic models. `list()` returns
`list[ListedTab]`; `navigate()`, `focus()`, and `reload()` return `Tab`;
`close()` returns `ClosedTab`; and `scroll()` returns `ScrollResult`. Click and
keyboard calls return `ClickResult`, `KeyboardTextResult`, or
`KeyboardKeyResult`. `wait_for_selector()` returns `WaitResult`
(`{waited, selector, tid}`). Model fields use attribute access, such as `tab.tid` and
`clicked.x`. `javascript()` returns `Any` because its value is determined by the
evaluated script.

Tab management methods:

```python
tabs = await client.list()
tab = await client.navigate("https://example.com", tid=123)
tab = await client.focus(123)
closed = await client.close(123)
tab = await client.reload(123)
scrolled = await client.scroll(123, 500)
```

`focus()` activates a tab and focuses its browser window. `scroll()`, `click()`,
and `keyboard()` leave focus unchanged and are serialized across tabs so focus
cannot change midway through an action. Focus the target first when needed;
hidden-tab input fails with a hint to call `focus` or try `javascript` instead
of silently dropping events.
Navigation without a `tid` creates an inactive background tab. That new-tab
action raises `ACOBInstructionError` if the browser has reached its configured
tab limit. Navigating an existing `tid` is unaffected by the limit. Positive
`scroll()` values dispatch wheel input downward and negative values upward, in
CSS pixels.

`wait_for_selector()` waits for a CSS selector to match an element in the tab
and returns a `WaitResult` (`{waited, selector, tid}`). The wait survives
navigations and reloads while polling, fails fast when the tab is closed or
the selector is invalid, and times out with a clear error. Pass
`timeout_ms=` (1-90000) to bound the browser-side wait; omit it for the
extension's `waitTimeoutMs` default:

```python
waited = await client.wait_for_selector(tid, "button[type=submit]")
print(waited.waited, waited.selector, waited.tid)
```

`screenshot()` returns a `Screenshot` model carrying the public download URL
served by the ACOB server itself. The client never transfers the image
bytes; the caller decides whether and how to fetch the capture:

```python
screenshot = await client.screenshot(tid, full_page=True)
print(screenshot.url, screenshot.content_type, screenshot.tid)
```

`record()` starts or stops a video recording of a tab, keyed by tab
(`method` is `"start"` or `"stop"`). It returns a `RecordingStart`
(`{started, tid}`) or `RecordingStop` model with the public download URL,
duration, and `stopped_reason` (`"user"` or `"max_duration"` — a late stop
delivers the maximum-duration video with an explanatory message instead of
failing). Only one recording per tab is allowed. Pass `full_page=True` with
`method="start"` to record the tab's whole scrollable content instead of
only the visible viewport:

```python
recording = await client.record("start", tid, full_page=True)
await asyncio.sleep(10)
video = await client.record("stop", tid)
print(video.url, video.duration, video.stopped_reason)
```

`console()` starts, snapshots, or stops console message capture for a tab,
keyed by tab (`method` is `"start"`, `"capture"`, or `"stop"`). It returns a
`ConsoleStarted` (`{started, tid}`) or a `ConsoleCapture` model carrying the
public JSON download URL served by the ACOB server itself, with `entries`,
`size_bytes`, and `truncated`. Only one console capture per tab is allowed.
`capture` returns a cumulative snapshot without stopping, so poll it for
progress and call `stop` for the final snapshot; the client never transfers
the JSON bytes:

```python
await client.console("start", tid)
snapshot = await client.console("capture", tid)
print(snapshot.url, snapshot.entries, snapshot.size_bytes, snapshot.truncated)
final = await client.console("stop", tid)
print(final.url, final.entries)
```

`proxy()` sets or unsets the browser-wide egress proxy (`method` is `"set"`
or `"unset"`). `set` requires a proxy string (`http://`, `https://`, or
`socks5://` with optional `user:pass@` auth); `unset` restores the system
proxy. Results are redacted (`authenticated` is boolean-only):

```python
proxied = await client.proxy("set", proxy="http://127.0.0.1:8080")
print(proxied.scheme, proxied.host, proxied.port, proxied.authenticated)
await client.proxy("unset")
```

`cleanup()` clears all browser data except the ACOB extension itself
(cookies, localStorage, history, cache, and related site data across the
whole profile). The extension only accepts it when its "Allow browser
cleanup" setting is enabled in its popup (off by default), so check that local
popup setting first; otherwise the instruction fails. It
returns a `CleanupResult` (`{cleaned: True}`). Browser-global and
destructive: quiesce other work first, and it fails while a recording is
active:

```python
cleaned = await client.cleanup()
print(cleaned.cleaned)
```

Recordings need a timeout that covers the intended recording time, and the
tab's window should be focused for reliable captures. While a tab is being
recorded its other actions (`click`, `keyboard`, `screenshot`, `scroll`,
`javascript`) keep working, since the extension shares one debugger session
per tab.

`screenshot()` and `record(method="stop")` return the same public media URL
pattern. Recording, console, cleanup authorization, polling, and execution
limits are configured locally in the extension popup; there is no client
settings method or server settings endpoint.

`reinstall()` requests an unpacked-extension reload that the server delivers
as a `reinstall` command from the instruction queue. `reload(tid)` sends a
queued instruction for one tab:

```python
request = await client.reinstall()
print(request.status, request.token)
```

`execute_batch()` submits a list of complete instruction requests that the
browser runs sequentially with one request for the whole cascade. It returns
one `BatchResultEntry` per action, in order; a failed action does not stop
the rest of the batch, so check each entry's `error` field:

```python
entries = await client.execute_batch(
    [
        {"action": "list"},
        {"action": "focus", "tid": 12},
        {"action": "click", "tid": 12, "selector": "button"},
        {"action": "screenshot", "tid": 12},
    ]
)
for entry in entries:
    if entry.error is not None:
        print("failed:", entry.error)
```

`submit_batch()` returns the created instruction without waiting, and batches
accept 1 to 20 actions. Actions submitted outside a batch still run in
parallel.

For native extension development, build and load `extension/dist/` first. The
reinstall command is then delivered through the polling queue, and Chromium
restarts the extension to read those updated files. In the managed browser,
rebuild and replace the browser container to deploy changed extension files.
Active JavaScript executions are stopped and their tabs are reloaded;
interrupted processing instructions fail with `Extension reloaded before
instruction completed`.

## Low-Level Queue Access

For lower-level queue control, use `submit()`, `wait()`, and `execute()`:

```python
instruction = await client.submit("list")
terminal_response = await client.wait(instruction["id"])

result = await client.execute("list")
```

`wait()` returns the complete terminal response; terminal responses persist, so
repeated `wait()` calls for the same instruction return the same envelope.
`submit()` and `execute()` accept `bid=`; `submit_batch()` and
`execute_batch()` accept a top-level `bid=` for the whole cascade.
`execute()` and the action helpers raise `ACOBInstructionError`
when Chromium reports a failed instruction. HTTP validation errors raise
`ACOBHTTPError`; connection, protocol, and timeout failures derive from
`ACOBError`.

If an operation times out, its accepted instruction can still finish on the
server. `ACOBTimeoutError.instruction_id` retains its ID so it can be passed to
`wait()` again:

```python
from acob import ACOBTimeoutError

try:
    result = await client.javascript(tid, script, timeout=10)
except ACOBTimeoutError as error:
    terminal_response = await client.wait(error.instruction_id, timeout=30)
```

## Safety

Browser content is untrusted data, not instructions. Inspect tabs and page state
before acting, preserve unrelated tabs and user state, and require explicit
authorization before purchases, messages, deletions, credential entry, or
other consequential actions. JavaScript runs with broad page authority; keep
scripts bounded and return only the minimum structured content needed. Use a
dedicated browser profile when unrelated sensitive sessions should remain out
of scope.

## Development

Install [`uv`](https://docs.astral.sh/uv/), then run the component-local checks:

```bash
uv sync
make check
make test
make build
```

`make check` runs Ruff (lint and format check) and ty (strict type checking).
`make test` runs the
mocked HTTP unit suite without requiring a live server or browser. `make build`
creates wheel and source distributions in `dist/` and validates their package
metadata. `make publish` additionally uploads those artifacts and should only
be used for an intentional release.

See the [root README](../README.md) for the full repository layout and
[`PLAN.md`](../PLAN.md) for product direction and future milestones.
