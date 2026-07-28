# ACOB Python Client

The ACOB Python client asynchronously controls one Chromium installation
through an ACOB server. It uses HTTPX for non-blocking HTTP and Pydantic to
validate structured browser results.

It requires Python 3.10 or newer. Install it from this directory:

```bash
python -m pip install .
```

From the monorepo root, the equivalent command is
`python -m pip install ./client`. The [server](../srv/README.md) and
[Chromium extension](../extension/README.md) must also be running to execute
browser instructions.

All operations that communicate with ACOB are awaitable. Create a client with
the browser ID shown in the extension popup and close it with `async with`:

```python
import asyncio
from pathlib import Path

from acob import ACOBClient


async def main() -> None:
    async with ACOBClient("0123456789ab4def8123456789abcdef") as client:
        tabs = await client.tabs(operation="list")
        tab = await client.tabs(
            operation="navigate",
            url="https://example.com",
        )
        tid = tab.tid

        await client.click(tid, "a")
        await client.keyboard(tid, text="ACOB")
        await client.keyboard(tid, key="Enter")
        title = await client.javascript(tid, "document.title")

        png = await client.screenshot(tid, full_page=True)
        Path("screenshot.png").write_bytes(png)


asyncio.run(main())
```

The endpoint defaults to `http://127.0.0.1:58347`. Use a different server and
operation timeout when needed:

```python
client = ACOBClient(
    "0123456789ab4def8123456789abcdef",
    endpoint="http://127.0.0.1:8000",
    timeout=90,
    poll_interval=0.5,
)
try:
    tabs = await client.tabs(operation="list")
finally:
    await client.aclose()
```

`timeout` is the default maximum duration for a complete browser instruction.
`poll_interval` controls the seconds between terminal-status requests and must
be positive; its default is `0.5`.

Keep a client within one event loop. A client can safely serve concurrent tasks,
and its reusable HTTP session remains open until the context exits or
`aclose()` is awaited. A closed client cannot be reused.

## Parallel Execution

Independent actions can be submitted and polled concurrently with
`asyncio.gather()`, so long-running work on independent tabs can overlap:

```python
first_tab, second_tab = await asyncio.gather(
    client.tabs(operation="navigate", url="https://example.com/first"),
    client.tabs(operation="navigate", url="https://example.com/second"),
)

first_title, second_title = await asyncio.gather(
    client.javascript(first_tab.tid, "document.title"),
    client.javascript(second_tab.tid, "document.title"),
)
```

Only parallelize operations that are independent. Await navigation before using
its returned tab ID, preserve ordering for click-and-type workflows, and avoid
concurrent debugger-backed actions on the same tab because they can conflict.
Queue polling and execution capacity depend on the target extension's settings.
Larger batches may remain queued and reach their client timeout.
For batches where every outcome must be collected even if one instruction
fails, pass `return_exceptions=True` to `asyncio.gather()` and inspect each
result.

Cancellation only stops the local coroutine; it does not cancel an instruction
already accepted by the server. Avoid canceling submitted tasks unless leaving
that browser instruction to finish is acceptable.

## Actions And Results

Action methods map directly to API actions and payload fields. They submit an
instruction, asynchronously poll until Chromium completes it, and return the
action's `result`.

Structured results are validated Pydantic models. `tabs(operation="list")`
returns `list[ListedTab]`; navigate and focus return `Tab`; close returns
`ClosedTab`. Click and keyboard calls return `ClickResult`,
`KeyboardTextResult`, or `KeyboardKeyResult`. Model fields use attribute access,
such as `tab.tid` and `clicked.x`. `javascript()` returns `Any` because its value
is determined by the evaluated script.

The `tabs()` method mirrors the four tab operations:

```python
tabs = await client.tabs(operation="list")
tab = await client.tabs(
    operation="navigate",
    tid=123,
    url="https://example.com",
)
tab = await client.tabs(operation="focus", tid=123)
closed = await client.tabs(operation="close", tid=123)
```

Only `operation="focus"` activates a tab or focuses its window. Navigation,
click, keyboard, JavaScript, and screenshot actions leave browser focus
unchanged; navigation without a `tid` creates an inactive background tab. That
new-tab operation raises `ACOBInstructionError` if the browser has reached its
configured tab limit. Navigating an existing `tid` is unaffected by the limit.

`screenshot()` returns PNG bytes. It immediately consumes the API's internal
single-use download URL, so a failed transfer requires a new screenshot call.

## Low-Level Queue Access

For lower-level queue control, use `submit()`, `wait()`, and `execute()`:

```python
instruction = await client.submit("tabs", operation="list")
terminal_response = await client.wait(instruction["id"])

result = await client.execute("tabs", operation="list")
```

`wait()` returns the complete terminal response because that response is
single-use. Do not call `wait()` concurrently more than once for the same
instruction. `execute()` and the action helpers raise `ACOBInstructionError`
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

## Development

Install [`uv`](https://docs.astral.sh/uv/), then run the component-local checks:

```bash
uv sync
make check
make test
make build
```

`make check` runs Ruff, Black in check mode, and Pyright. `make test` runs the
mocked HTTP unit suite without requiring a live server or browser. `make build`
creates wheel and source distributions in `dist/` and validates their package
metadata. `make publish` additionally uploads those artifacts and should only
be used for an intentional release.

See the [root README](../README.md) for the full repository layout and
[`docs/SKILL.md`](../docs/SKILL.md) for agent-oriented usage guidance.
