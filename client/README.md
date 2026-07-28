# ACOB Python Client

The ACOB Python client controls one Chromium installation through an ACOB
server. It uses Pydantic to validate structured browser results.

Install it from the repository:

```bash
pip install ./client
```

Create a client with the browser ID shown in the extension popup. The endpoint
defaults to `http://127.0.0.1:58347`:

```python
from pathlib import Path

from acob import ACOBClient

client = ACOBClient("0123456789ab4def8123456789abcdef")

tabs = client.tabs(operation="list")
tab = client.tabs(operation="navigate", url="https://example.com")
tid = tab.tid

client.click(tid, "a")
client.keyboard(tid, text="ACOB")
client.keyboard(tid, key="Enter")
title = client.javascript(tid, "document.title")

png = client.screenshot(tid, full_page=True)
Path("screenshot.png").write_bytes(png)
```

Use a different server and operation timeout when needed:

```python
client = ACOBClient(
    "0123456789ab4def8123456789abcdef",
    endpoint="http://127.0.0.1:8000",
    timeout=90,
)
```

Action methods map directly to the API actions and payload fields. They submit
an instruction, poll until Chromium completes it, and return the action's
`result`.

Structured results are validated Pydantic models. `tabs(operation="list")`
returns `list[ListedTab]`; navigate and focus return `Tab`; close returns
`ClosedTab`. Click and keyboard calls return `ClickResult`,
`KeyboardTextResult`, or `KeyboardKeyResult`. Model fields use attribute access,
such as `tab.tid` and `clicked.x`. `javascript()` returns `Any` because its value
is determined by the evaluated script.

The `tabs()` method mirrors the four tab operations:

```python
tabs = client.tabs(operation="list")
tab = client.tabs(
    operation="navigate",
    tid=123,
    url="https://example.com",
)
tab = client.tabs(operation="focus", tid=123)
closed = client.tabs(operation="close", tid=123)
```

Only `operation="focus"` activates a tab or focuses its window. Navigation,
click, keyboard, JavaScript, and screenshot actions leave browser focus unchanged;
navigation without a `tid` creates an inactive background tab.

`screenshot()` returns PNG bytes. It immediately consumes the API's internal
single-use download URL, so a failed transfer requires a new screenshot call.

For lower-level queue control, use `submit()`, `wait()`, and `execute()`:

```python
instruction = client.submit("tabs", operation="list")
terminal_response = client.wait(instruction["id"])

result = client.execute("tabs", operation="list")
```

`wait()` returns the complete terminal response because that response is
single-use. `execute()` and the action helpers raise `ACOBInstructionError`
when Chromium reports a failed instruction. HTTP validation errors raise
`ACOBHTTPError`; connection, protocol, and timeout failures derive from
`ACOBError`.

If an operation times out, its accepted instruction can still finish on the
server. `ACOBTimeoutError.instruction_id` retains its ID so it can be passed to
`wait()` again.
