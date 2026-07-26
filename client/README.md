# ACOB Python Client

The ACOB Python client controls one Chromium installation through an ACOB
server. It uses only the Python standard library.

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
tid = tab["tid"]

client.click(tid, "a")
client.keyboard(tid, text="ACOB")
client.keyboard(tid, key="Enter")
title = client.javascript(tid, "document.title")

capture = client.screenshot(tid, full_page=True)
png = client.download_screenshot(capture["download_url"])
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

`screenshot()` returns the API's screenshot metadata unchanged. Its
`download_url` is single-use, so pass it directly to `download_screenshot()`
when ready to consume the PNG.

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
