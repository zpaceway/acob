import asyncio
import json
import math
from collections.abc import Sequence
from types import TracebackType
from typing import Annotated, Literal, TypeAlias, TypeVar, cast, overload
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    TypeAdapter,
    ValidationError,
    model_validator,
)
from typing_extensions import Self

DEFAULT_ENDPOINT = "http://127.0.0.1:58347"
UUIDV4_VERSION = 4

JsonObject: TypeAlias = dict[str, JsonValue]
KeyboardModifier: TypeAlias = Literal["alt", "ctrl", "meta", "shift"]
ProxyMethod: TypeAlias = Literal["set", "unset"]
ProxyScheme: TypeAlias = Literal["http", "https", "socks5"]
RecordMethod: TypeAlias = Literal["start", "stop"]
ConsoleMethod: TypeAlias = Literal["start", "capture", "stop"]
MAX_PROXY_LENGTH = 2048


class _ResultModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Tab(_ResultModel):
    tid: int
    window_id: int
    active: bool
    title: str | None
    url: str | None
    domain: str | None


class ListedTab(Tab):
    focused: bool


class ClosedTab(_ResultModel):
    closed: Literal[True]
    tab: Tab


class ScrollResult(_ResultModel):
    scrolled: Literal[True]
    y: Annotated[float, Field(allow_inf_nan=False)]


class ClickResult(_ResultModel):
    clicked: Literal[True]
    selector: str
    x: float
    y: float


class KeyboardTextResult(_ResultModel):
    inserted_characters: int


class KeyboardKeyResult(_ResultModel):
    key: str
    modifiers: list[KeyboardModifier]


class ReinstallResult(_ResultModel):
    token: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    status: Literal["pending"]
    requested_at: str = Field(min_length=1)


class BrowserSettings(_ResultModel):
    settings: dict[str, JsonValue]
    updated_at: str = Field(min_length=1)


class RecordingStart(_ResultModel):
    started: Literal[True]
    tid: int


class _RecordingStartMetadata(_ResultModel):
    started: Literal[True]


class RecordingStop(_ResultModel):
    url: str = Field(min_length=1)
    content_type: Literal["video/mp4", "video/webm"]
    duration: float
    stopped_reason: Literal["user", "max_duration"]
    message: str
    tid: int


class ConsoleStarted(_ResultModel):
    started: Literal[True]
    tid: int


class _ConsoleStartedMetadata(_ResultModel):
    started: Literal[True]


class ConsoleCapture(_ResultModel):
    url: str = Field(min_length=1)
    content_type: Literal["application/json"]
    entries: int
    size_bytes: int
    truncated: bool
    tid: int


class _ConsoleCaptureMetadata(_ResultModel):
    url: str = Field(min_length=1)
    content_type: Literal["application/json"]
    entries: int
    size_bytes: int
    truncated: bool


class ProxySet(_ResultModel):
    proxied: Literal[True]
    scheme: ProxyScheme
    host: str = Field(min_length=1)
    port: int = Field(ge=1, le=65535)
    authenticated: bool


class _ProxySetMetadata(_ResultModel):
    proxied: Literal[True]
    scheme: ProxyScheme
    host: str = Field(min_length=1)
    port: int = Field(ge=1, le=65535)
    authenticated: bool


class ProxyUnset(_ResultModel):
    proxied: Literal[False]


class _ProxyUnsetMetadata(_ResultModel):
    proxied: Literal[False]


class _ScreenshotMetadata(_ResultModel):
    url: str = Field(min_length=1)
    content_type: Literal["image/png"]
    full_page: bool


class _RecordingStopMetadata(_ResultModel):
    url: str = Field(min_length=1)
    content_type: Literal["video/mp4", "video/webm"]
    duration: float
    stopped_reason: Literal["user", "max_duration"]
    message: str = Field(min_length=1)


class BatchResultEntry(_ResultModel):
    """One batch action's result: either a result or an error."""

    result: JsonValue = None
    error: str | None = None

    @model_validator(mode="after")
    def validate_entry(self) -> Self:
        if self.error is not None and self.result is not None:
            raise ValueError("result and error cannot both be provided")
        return self


class Screenshot(_ResultModel):
    url: str = Field(min_length=1)
    content_type: Literal["image/png"]
    full_page: bool
    tid: int


_LISTED_TABS_ADAPTER = TypeAdapter(list[ListedTab])
_BATCH_RESULTS_ADAPTER = TypeAdapter(list[BatchResultEntry])
_ModelT = TypeVar("_ModelT", bound=BaseModel)


class ACOBError(Exception):
    """Base exception for ACOB client failures."""


class ACOBConnectionError(ACOBError):
    """The ACOB server could not be reached."""


class ACOBProtocolError(ACOBError):
    """The ACOB server returned an unexpected response."""


class ACOBHTTPError(ACOBError):
    """The ACOB server rejected an HTTP request."""

    def __init__(
        self,
        status_code: int,
        message: str,
        response: JsonObject | None = None,
    ) -> None:
        super().__init__(f"{message} (HTTP {status_code})")
        self.status_code = status_code
        self.response = response


class ACOBInstructionError(ACOBError):
    """Chromium failed to execute an accepted instruction."""

    def __init__(self, instruction_id: int, response: JsonObject) -> None:
        message = response.get("error")
        if not isinstance(message, str) or not message:
            message = "Browser instruction failed"
        super().__init__(message)
        self.instruction_id = instruction_id
        self.response = response


class ACOBTimeoutError(ACOBError):
    """An instruction did not finish before the configured timeout."""

    def __init__(self, instruction_id: int, timeout: float) -> None:
        super().__init__(
            f"Instruction {instruction_id} did not finish within {timeout:g} seconds",
        )
        self.instruction_id = instruction_id
        self.timeout = timeout


class ACOBClient:
    """Asynchronous client for controlling one ACOB browser."""

    _REQUEST_TIMEOUT = 60.0

    def __init__(
        self,
        bid: str,
        endpoint: str | None = None,
        *,
        timeout: float = 60.0,
        poll_interval: float = 0.5,
    ) -> None:
        self.bid = self._validate_bid(bid)
        self.endpoint = self._validate_endpoint(
            DEFAULT_ENDPOINT if endpoint is None else endpoint,
        )
        self.timeout = self._positive_float(timeout, "timeout")
        self.poll_interval = self._positive_float(
            poll_interval,
            "poll_interval",
        )
        self._instructions_url = f"{self.endpoint}/api/browsers/{self.bid}/instructions"
        self._reinstall_url = f"{self.endpoint}/api/browsers/{self.bid}/reinstall/"
        self._settings_url = f"{self.endpoint}/api/browsers/{self.bid}/settings/"
        self._http_client: httpx.AsyncClient | None = None
        self._close_task: asyncio.Task[None] | None = None
        self._closed = False

    async def __aenter__(self) -> Self:
        if self._closed:
            raise ACOBError("ACOBClient is closed")
        return self

    async def __aexit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc_value: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the underlying asynchronous HTTP client."""
        if self._close_task is None:
            self._closed = True
            self._close_task = asyncio.create_task(self._close_http_client())
        await asyncio.shield(self._close_task)

    async def submit(self, action: str, /, **payload: JsonValue) -> JsonObject:
        """Submit an instruction without waiting for Chromium to execute it."""
        body = dict(payload)
        body["action"] = action
        return await self._request_json(
            "POST",
            f"{self._instructions_url}/",
            body,
            timeout=min(self._REQUEST_TIMEOUT, self.timeout),
        )

    async def wait(
        self,
        instruction_id: int,
        *,
        timeout: float | None = None,
    ) -> JsonObject:
        """Wait for and return an instruction's one-use terminal response."""
        if (
            isinstance(instruction_id, bool)
            or not isinstance(instruction_id, int)
            or instruction_id <= 0
        ):
            raise ValueError("instruction_id must be a positive integer")

        wait_timeout = (
            self.timeout
            if timeout is None
            else self._positive_float(timeout, "timeout")
        )
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_timeout
        instruction_url = f"{self._instructions_url}/{instruction_id}/"

        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise ACOBTimeoutError(instruction_id, wait_timeout)

            response = await self._request_json(
                "GET",
                instruction_url,
                timeout=min(self._REQUEST_TIMEOUT, remaining),
            )
            status = response.get("status")
            response_id = response.get("id")
            if (
                isinstance(response_id, bool)
                or response_id != instruction_id
                or not isinstance(status, str)
            ):
                raise ACOBProtocolError(
                    f"Instruction {instruction_id} returned an invalid response",
                )
            if status in {"completed", "failed"}:
                return response
            if status not in {"pending", "processing"}:
                raise ACOBProtocolError(
                    f"Instruction {instruction_id} returned invalid status: {status!r}",
                )

            remaining = deadline - loop.time()
            if remaining <= 0:
                raise ACOBTimeoutError(instruction_id, wait_timeout)
            await asyncio.sleep(min(self.poll_interval, remaining))

    async def execute(
        self,
        action: str,
        /,
        *,
        timeout: float | None = None,
        **payload: JsonValue,
    ) -> JsonValue:
        """Submit an action, wait for it, and return its browser result."""
        instruction = await self.submit(action, **payload)
        instruction_id = instruction.get("id")
        if (
            isinstance(instruction_id, bool)
            or not isinstance(instruction_id, int)
            or instruction_id <= 0
        ):
            raise ACOBProtocolError("Created instruction did not contain a valid id")

        terminal = await self.wait(instruction_id, timeout=timeout)
        if terminal.get("status") == "failed":
            raise ACOBInstructionError(instruction_id, terminal)
        return terminal.get("result")

    async def submit_batch(self, actions: Sequence[JsonObject], /) -> JsonObject:
        """Submit a batch of instructions that run sequentially in the browser.

        Each entry is a complete instruction request, e.g.
        ``{"action": "click", "tid": 12, "selector": "button"}``. The
        extension executes the actions one at a time in order and reports one
        result or error per action.
        """
        if not actions:
            raise ValueError("actions must contain at least one instruction")
        for action in actions:
            if not isinstance(action, dict):
                raise TypeError("each action must be an instruction object")
        body: JsonObject = {
            "action": "batch",
            "actions": [dict(action) for action in actions],
        }
        return await self._request_json(
            "POST",
            f"{self._instructions_url}/batch/",
            body,
            timeout=min(self._REQUEST_TIMEOUT, self.timeout),
        )

    async def execute_batch(
        self,
        actions: Sequence[JsonObject],
        /,
        *,
        timeout: float | None = None,
    ) -> list[BatchResultEntry]:
        """Submit a batch and wait for every action to finish.

        The browser runs the actions sequentially and the returned list holds
        one ``BatchResultEntry`` per action, in order. A failed action does
        not stop the rest of the batch; check each entry's ``error`` field.
        """
        instruction = await self.submit_batch(actions)
        instruction_id = instruction.get("id")
        if (
            isinstance(instruction_id, bool)
            or not isinstance(instruction_id, int)
            or instruction_id <= 0
        ):
            raise ACOBProtocolError("Created instruction did not contain a valid id")

        terminal = await self.wait(instruction_id, timeout=timeout)
        if terminal.get("status") == "failed":
            raise ACOBInstructionError(instruction_id, terminal)
        try:
            return _BATCH_RESULTS_ADAPTER.validate_python(
                terminal.get("result"),
                strict=True,
            )
        except ValidationError as error:
            raise ACOBProtocolError("batch returned an invalid result") from error

    async def list(self, *, timeout: float | None = None) -> list[ListedTab]:
        """List Chromium tabs."""
        result = await self.execute("list", timeout=timeout)
        try:
            return _LISTED_TABS_ADAPTER.validate_python(result, strict=True)
        except ValidationError as error:
            raise ACOBProtocolError("list returned an invalid result") from error

    async def navigate(
        self,
        url: str,
        *,
        tid: int | None = None,
        timeout: float | None = None,
    ) -> Tab:
        """Navigate a tab, or create an inactive tab when tid is omitted."""
        payload: JsonObject = {"url": url}
        if tid is not None:
            payload["tid"] = tid
        return self._expect_model(
            await self.execute("navigate", timeout=timeout, **payload),
            Tab,
            "navigate",
        )

    async def focus(
        self,
        tid: int,
        *,
        timeout: float | None = None,
    ) -> Tab:
        """Activate a Chromium tab within its window without raising the window."""
        return self._expect_model(
            await self.execute("focus", tid=tid, timeout=timeout),
            Tab,
            "focus",
        )

    async def close(
        self,
        tid: int,
        *,
        timeout: float | None = None,
    ) -> ClosedTab:
        """Close a Chromium tab."""
        return self._expect_model(
            await self.execute("close", tid=tid, timeout=timeout),
            ClosedTab,
            "close",
        )

    async def reload(
        self,
        tid: int,
        *,
        timeout: float | None = None,
    ) -> Tab:
        """Reload a Chromium tab and wait for it to load."""
        return self._expect_model(
            await self.execute("reload", tid=tid, timeout=timeout),
            Tab,
            "reload",
        )

    async def scroll(
        self,
        tid: int,
        y: float,
        *,
        timeout: float | None = None,
    ) -> ScrollResult:
        """Scroll a Chromium tab vertically by y CSS pixels."""
        return self._expect_model(
            await self.execute("scroll", tid=tid, y=y, timeout=timeout),
            ScrollResult,
            "scroll",
        )

    async def click(
        self,
        tid: int,
        selector: str,
        *,
        timeout: float | None = None,
    ) -> ClickResult:
        """Click the center of the element matching a CSS selector."""
        return self._expect_model(
            await self.execute(
                "click",
                tid=tid,
                selector=selector,
                timeout=timeout,
            ),
            ClickResult,
            "click",
        )

    @overload
    async def keyboard(
        self,
        tid: int,
        *,
        text: str,
        key: None = None,
        modifiers: None = None,
        timeout: float | None = None,
    ) -> KeyboardTextResult: ...

    @overload
    async def keyboard(
        self,
        tid: int,
        *,
        text: None = None,
        key: str,
        modifiers: Sequence[KeyboardModifier] | None = None,
        timeout: float | None = None,
    ) -> KeyboardKeyResult: ...

    async def keyboard(
        self,
        tid: int,
        *,
        text: str | None = None,
        key: str | None = None,
        modifiers: Sequence[KeyboardModifier] | None = None,
        timeout: float | None = None,
    ) -> KeyboardTextResult | KeyboardKeyResult:
        """Insert text or dispatch one key to the focused page control."""
        payload: JsonObject = {"tid": tid}
        if text is not None:
            payload["text"] = text
        if key is not None:
            payload["key"] = key
        if modifiers is not None:
            payload["modifiers"] = list(modifiers)
        result = await self.execute("keyboard", timeout=timeout, **payload)
        if text is not None:
            return self._expect_model(result, KeyboardTextResult, "keyboard")
        return self._expect_model(result, KeyboardKeyResult, "keyboard")

    async def screenshot(
        self,
        tid: int,
        *,
        full_page: bool = True,
        timeout: float | None = None,
    ) -> Screenshot:
        """Capture a tab and return its public download URL.

        The ACOB server serves the capture at the returned URL; the client
        never transfers the image bytes, and the caller decides whether and
        how to download the capture.
        """
        result = self._expect_model(
            await self.execute(
                "screenshot",
                tid=tid,
                full_page=full_page,
                timeout=timeout,
            ),
            _ScreenshotMetadata,
            "screenshot",
        )
        self._validate_media_url(result.url, "Screenshot")
        return Screenshot(
            url=result.url,
            content_type=result.content_type,
            full_page=result.full_page,
            tid=tid,
        )

    @overload
    async def record(
        self,
        method: Literal["start"],
        tid: int,
        *,
        full_page: bool = False,
        timeout: float | None = None,
    ) -> RecordingStart: ...

    @overload
    async def record(
        self,
        method: Literal["stop"],
        tid: int,
        *,
        timeout: float | None = None,
    ) -> RecordingStop: ...

    async def record(
        self,
        method: RecordMethod,
        tid: int,
        *,
        full_page: bool = False,
        timeout: float | None = None,
    ) -> RecordingStart | RecordingStop:
        """Start or stop a video recording of a tab, keyed by tab.

        Only one recording per tab is allowed. ``start`` accepts
        ``full_page`` to record the whole scrollable content; ``stop``
        delivers the finalized video URL.
        """
        self._validate_tid(tid)
        if method not in ("start", "stop"):
            raise ValueError("method must be 'start' or 'stop'")
        if method == "stop" and full_page:
            raise ValueError("full_page is only valid when method is 'start'")
        if method == "start":
            result = self._expect_model(
                await self.execute(
                    "record",
                    method="start",
                    tid=tid,
                    full_page=full_page,
                    timeout=timeout,
                ),
                _RecordingStartMetadata,
                "record",
            )
            return RecordingStart(started=result.started, tid=tid)
        result_stop = self._expect_model(
            await self.execute("record", method="stop", tid=tid, timeout=timeout),
            _RecordingStopMetadata,
            "record",
        )
        self._validate_media_url(result_stop.url, "Recording")
        return RecordingStop(
            url=result_stop.url,
            content_type=result_stop.content_type,
            duration=result_stop.duration,
            stopped_reason=result_stop.stopped_reason,
            message=result_stop.message,
            tid=tid,
        )

    @overload
    async def console(
        self,
        method: Literal["start"],
        tid: int,
        *,
        timeout: float | None = None,
    ) -> ConsoleStarted: ...

    @overload
    async def console(
        self,
        method: Literal["capture", "stop"],
        tid: int,
        *,
        timeout: float | None = None,
    ) -> ConsoleCapture: ...

    async def console(
        self,
        method: ConsoleMethod,
        tid: int,
        *,
        timeout: float | None = None,
    ) -> ConsoleStarted | ConsoleCapture:
        """Start, snapshot, or stop console message capture for a tab.

        Only one console capture per tab is allowed. ``start`` begins
        buffering console messages in the background; ``capture`` returns
        a cumulative snapshot without stopping; ``stop`` ends the session
        and delivers the final snapshot through the public download URL.
        """
        self._validate_tid(tid)
        if method not in ("start", "capture", "stop"):
            raise ValueError("method must be 'start', 'capture' or 'stop'")
        if method == "start":
            result = self._expect_model(
                await self.execute(
                    "console",
                    method="start",
                    tid=tid,
                    timeout=timeout,
                ),
                _ConsoleStartedMetadata,
                "console",
            )
            return ConsoleStarted(started=result.started, tid=tid)
        result_capture = self._expect_model(
            await self.execute(
                "console",
                method=method,
                tid=tid,
                timeout=timeout,
            ),
            _ConsoleCaptureMetadata,
            "console",
        )
        self._validate_media_url(result_capture.url, "Console")
        return ConsoleCapture(
            url=result_capture.url,
            content_type=result_capture.content_type,
            entries=result_capture.entries,
            size_bytes=result_capture.size_bytes,
            truncated=result_capture.truncated,
            tid=tid,
        )

    @overload
    async def proxy(
        self,
        method: Literal["set"],
        *,
        proxy: str,
        timeout: float | None = None,
    ) -> ProxySet: ...

    @overload
    async def proxy(
        self,
        method: Literal["unset"],
        *,
        timeout: float | None = None,
    ) -> ProxyUnset: ...

    async def proxy(
        self,
        method: ProxyMethod,
        *,
        proxy: str | None = None,
        timeout: float | None = None,
    ) -> ProxySet | ProxyUnset:
        """Set or unset the browser-wide egress proxy.

        ``set`` requires a proxy string like
        ``http://user:pass@host:port`` (schemes http, https, socks5).
        ``unset`` restores the system proxy. The proxy is browser-global,
        not per-tab.
        """
        if method not in ("set", "unset"):
            raise ValueError("method must be 'set' or 'unset'")
        if method == "set":
            if not isinstance(proxy, str) or not proxy.strip():
                raise ValueError("proxy is required when method is 'set'")
            if len(proxy) > MAX_PROXY_LENGTH:
                raise ValueError("proxy string is too long")
            result = self._expect_model(
                await self.execute("proxy", method="set", proxy=proxy, timeout=timeout),
                _ProxySetMetadata,
                "proxy",
            )
            return ProxySet(
                proxied=result.proxied,
                scheme=result.scheme,
                host=result.host,
                port=result.port,
                authenticated=result.authenticated,
            )
        if proxy is not None:
            raise ValueError("proxy must not be provided when method is 'unset'")
        result_unset = self._expect_model(
            await self.execute("proxy", method="unset", timeout=timeout),
            _ProxyUnsetMetadata,
            "proxy",
        )
        return ProxyUnset(proxied=result_unset.proxied)

    async def settings(
        self,
        *,
        timeout: float | None = None,
    ) -> BrowserSettings:
        """Return the settings most recently reported by the extension.

        The extension reports its settings periodically and whenever they
        change, so a fresh installation may return 404 until the first report.
        """
        return self._expect_model(
            await self._request_json(
                "GET",
                self._settings_url,
                timeout=min(timeout or self.timeout, self.timeout),
            ),
            BrowserSettings,
            "settings",
        )

    async def javascript(
        self,
        tid: int,
        script: str,
        *,
        timeout: float | None = None,
    ) -> JsonValue:
        """Evaluate JavaScript in a tab and return its value."""
        return await self.execute(
            "javascript",
            tid=tid,
            script=script,
            timeout=timeout,
        )

    async def reinstall(self) -> ReinstallResult:
        """Reinstall the unpacked extension from disk after rebuilding it."""
        return self._expect_model(
            await self._request_json(
                "POST",
                self._reinstall_url,
                timeout=min(self._REQUEST_TIMEOUT, self.timeout),
            ),
            ReinstallResult,
            "reinstall",
        )

    async def _request_json(
        self,
        method: str,
        url: str,
        body: JsonObject | None = None,
        *,
        timeout: float,
    ) -> JsonObject:
        raw = await self._request_bytes(method, url, body, timeout=timeout)
        try:
            parsed: object = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ACOBProtocolError(f"{method} {url} returned invalid JSON") from error
        if not isinstance(parsed, dict):
            raise ACOBProtocolError(
                f"{method} {url} returned a non-object JSON response",
            )
        return cast("JsonObject", parsed)

    async def _request_bytes(
        self,
        method: str,
        url: str,
        body: JsonObject | None = None,
        *,
        timeout: float,
    ) -> bytes:
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(
                body,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        try:
            response = await self._get_http_client().request(
                method,
                url,
                content=data,
                headers=headers,
                timeout=timeout,
            )
        except httpx.RequestError as error:
            reason = str(error) or type(error).__name__
            raise ACOBConnectionError(
                f"Could not connect to ACOB at {self.endpoint}: {reason}",
            ) from error

        if not httpx.codes.OK <= response.status_code < httpx.codes.MULTIPLE_CHOICES:
            parsed = self._try_parse_object(response.content)
            message = self._http_error_message(parsed)
            raise ACOBHTTPError(response.status_code, message, parsed)
        return response.content

    def _get_http_client(self) -> httpx.AsyncClient:
        if self._closed:
            raise ACOBError("ACOBClient is closed")
        if self._http_client is None:
            self._http_client = httpx.AsyncClient()
        return self._http_client

    async def _close_http_client(self) -> None:
        if self._http_client is not None:
            await self._http_client.aclose()

    @staticmethod
    def _validate_tid(tid: int) -> None:
        if isinstance(tid, bool) or not isinstance(tid, int) or tid <= 0:
            raise ValueError("tid must be a positive integer")

    @staticmethod
    def _expect_model(
        result: JsonValue,
        model: type[_ModelT],
        action: str,
    ) -> _ModelT:
        try:
            return model.model_validate(result)
        except ValidationError as error:
            raise ACOBProtocolError(f"{action} returned an invalid result") from error

    @staticmethod
    def _validate_media_url(url: str, action: str) -> None:
        try:
            parsed = urlsplit(url)
            if (
                parsed.scheme not in {"http", "https"}
                or parsed.hostname is None
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("invalid URL")
        except ValueError as error:
            raise ACOBProtocolError(
                f"{action} returned an invalid download URL",
            ) from error

    @staticmethod
    def _try_parse_object(body: bytes) -> JsonObject | None:
        try:
            parsed: object = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return cast("JsonObject", parsed) if isinstance(parsed, dict) else None

    @staticmethod
    def _http_error_message(response: JsonObject | None) -> str:
        if response is None:
            return "ACOB request failed"
        message = response.get("error")
        if not isinstance(message, str) or not message:
            return "ACOB request failed"

        details = response.get("details")
        if not isinstance(details, list):
            return message
        rendered_details = []
        for detail in details:
            if not isinstance(detail, dict):
                continue
            field = detail.get("field")
            detail_message = detail.get("message")
            if isinstance(field, str) and isinstance(detail_message, str):
                rendered_details.append(f"{field}: {detail_message}")
        return (
            f"{message}: {'; '.join(rendered_details)}" if rendered_details else message
        )

    @staticmethod
    def _validate_bid(bid: str) -> str:
        try:
            parsed = UUID(bid)
        except (ValueError, TypeError, AttributeError) as error:
            raise ValueError("bid must be a lowercase dashless UUIDv4") from error
        if parsed.hex != bid or parsed.version != UUIDV4_VERSION:
            raise ValueError("bid must be a lowercase dashless UUIDv4")
        return bid

    @staticmethod
    def _validate_endpoint(endpoint: str) -> str:
        if not isinstance(endpoint, str) or not endpoint:
            raise ValueError("endpoint must be a non-empty HTTP or HTTPS URL")
        normalized = endpoint.rstrip("/")
        try:
            parsed = urlsplit(normalized)
            _ = parsed.port
        except ValueError as error:
            raise ValueError("endpoint must be a valid HTTP or HTTPS URL") from error
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname is None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("endpoint must be a valid HTTP or HTTPS URL")
        return normalized

    @staticmethod
    def _positive_float(value: float, name: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError(f"{name} must be a positive number")
        converted = float(value)
        if not math.isfinite(converted) or converted <= 0:
            raise ValueError(f"{name} must be a positive number")
        return converted
