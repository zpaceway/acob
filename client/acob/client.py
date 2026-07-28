import asyncio
import json
import math
from collections.abc import Sequence
from types import TracebackType
from typing import Any, Literal, TypeAlias, TypeVar, cast, overload
from urllib.parse import SplitResult, urljoin, urlsplit
from uuid import UUID

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    TypeAdapter,
    ValidationError,
)

DEFAULT_ENDPOINT = "http://127.0.0.1:58347"

JsonObject: TypeAlias = dict[str, JsonValue]
TabOperation: TypeAlias = Literal["list", "close", "focus", "navigate"]
KeyboardModifier: TypeAlias = Literal["alt", "ctrl", "meta", "shift"]


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


class _ScreenshotMetadata(_ResultModel):
    download_url: str = Field(min_length=1)
    content_type: Literal["image/png"]
    full_page: bool
    single_use: Literal[True]
    tid: int


_LISTED_TABS_ADAPTER = TypeAdapter(list[ListedTab])
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
            f"Instruction {instruction_id} did not finish within {timeout:g} seconds"
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
            DEFAULT_ENDPOINT if endpoint is None else endpoint
        )
        self.timeout = self._positive_float(timeout, "timeout")
        self.poll_interval = self._positive_float(
            poll_interval,
            "poll_interval",
        )
        self._instructions_url = f"{self.endpoint}/api/browsers/{self.bid}/instructions"
        self._http_client: httpx.AsyncClient | None = None
        self._close_task: asyncio.Task[None] | None = None
        self._closed = False

    async def __aenter__(self) -> "ACOBClient":
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
                    f"Instruction {instruction_id} returned an invalid response"
                )
            if status in {"completed", "failed"}:
                return response
            if status not in {"pending", "processing"}:
                raise ACOBProtocolError(
                    f"Instruction {instruction_id} returned invalid status: {status!r}"
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
    ) -> Any:
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

    @overload
    async def tabs(
        self,
        operation: Literal["list"],
        *,
        tid: None = None,
        url: None = None,
        timeout: float | None = None,
    ) -> list[ListedTab]: ...

    @overload
    async def tabs(
        self,
        operation: Literal["navigate"],
        *,
        tid: int | None = None,
        url: str,
        timeout: float | None = None,
    ) -> Tab: ...

    @overload
    async def tabs(
        self,
        operation: Literal["focus"],
        *,
        tid: int,
        url: None = None,
        timeout: float | None = None,
    ) -> Tab: ...

    @overload
    async def tabs(
        self,
        operation: Literal["close"],
        *,
        tid: int,
        url: None = None,
        timeout: float | None = None,
    ) -> ClosedTab: ...

    async def tabs(
        self,
        operation: TabOperation,
        *,
        tid: int | None = None,
        url: str | None = None,
        timeout: float | None = None,
    ) -> list[ListedTab] | Tab | ClosedTab:
        """Run a list, navigate, focus, or close tab operation."""
        payload: JsonObject = {"operation": operation}
        if tid is not None:
            payload["tid"] = tid
        if url is not None:
            payload["url"] = url
        result = await self.execute("tabs", timeout=timeout, **payload)
        if operation == "list":
            try:
                return _LISTED_TABS_ADAPTER.validate_python(result, strict=True)
            except ValidationError as error:
                raise ACOBProtocolError("tabs returned an invalid result") from error
        if operation in {"navigate", "focus"}:
            return self._expect_model(result, Tab, "tabs")
        return self._expect_model(result, ClosedTab, "tabs")

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
        full_page: bool = False,
        timeout: float | None = None,
    ) -> bytes:
        """Capture a tab and return its PNG bytes."""
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
        resolved_url = urljoin(f"{self.endpoint}/", result.download_url)
        try:
            has_different_origin = self._origin(urlsplit(resolved_url)) != self._origin(
                urlsplit(self.endpoint)
            )
        except ValueError as error:
            raise ACOBProtocolError(
                "Screenshot returned an invalid download URL"
            ) from error
        if has_different_origin:
            raise ACOBProtocolError(
                "Screenshot download URL points to a different server"
            )
        return await self._request_bytes(
            "GET",
            resolved_url,
            timeout=min(self._REQUEST_TIMEOUT, self.timeout),
            accept="image/png",
        )

    async def javascript(
        self,
        tid: int,
        script: str,
        *,
        timeout: float | None = None,
    ) -> Any:
        """Evaluate JavaScript in a tab and return its value."""
        return await self.execute(
            "javascript",
            tid=tid,
            script=script,
            timeout=timeout,
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
                f"{method} {url} returned a non-object JSON response"
            )
        return cast(JsonObject, parsed)

    async def _request_bytes(
        self,
        method: str,
        url: str,
        body: JsonObject | None = None,
        *,
        timeout: float,
        accept: str = "application/json",
    ) -> bytes:
        headers = {"Accept": accept}
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
                f"Could not connect to ACOB at {self.endpoint}: {reason}"
            ) from error

        if not 200 <= response.status_code < 300:
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
    def _expect_model(
        result: Any,
        model: type[_ModelT],
        action: str,
    ) -> _ModelT:
        try:
            return model.model_validate(result)
        except ValidationError as error:
            raise ACOBProtocolError(f"{action} returned an invalid result") from error

    @staticmethod
    def _try_parse_object(body: bytes) -> JsonObject | None:
        try:
            parsed: object = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return cast(JsonObject, parsed) if isinstance(parsed, dict) else None

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
        if parsed.hex != bid or parsed.version != 4:
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
    def _origin(url: SplitResult) -> tuple[str, str | None, int | None]:
        default_port = 443 if url.scheme == "https" else 80
        return url.scheme.lower(), url.hostname, url.port or default_port

    @staticmethod
    def _positive_float(value: float, name: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{name} must be a positive number")
        converted = float(value)
        if not math.isfinite(converted) or converted <= 0:
            raise ValueError(f"{name} must be a positive number")
        return converted
