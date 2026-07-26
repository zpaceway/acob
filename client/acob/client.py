import json
import math
import time
from collections.abc import Sequence
from typing import TypeAlias, TypedDict, cast
from urllib.error import HTTPError, URLError
from urllib.parse import SplitResult, urljoin, urlsplit
from urllib.request import Request, urlopen
from uuid import UUID

DEFAULT_ENDPOINT = "http://127.0.0.1:58347"

JsonValue: TypeAlias = (
    bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"] | None
)
JsonObject: TypeAlias = dict[str, JsonValue]


class ScreenshotResult(TypedDict):
    download_url: str
    content_type: str
    full_page: bool
    single_use: bool
    tid: int


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
    """Synchronous client for controlling one ACOB browser."""

    _REQUEST_TIMEOUT = 10.0

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
        self._instructions_url = (
            f"{self.endpoint}/api/browsers/{self.bid}/instructions"
        )

    def submit(self, action: str, /, **payload: JsonValue) -> JsonObject:
        """Submit an instruction without waiting for Chromium to execute it."""
        body = dict(payload)
        body["action"] = action
        return self._request_json(
            "POST",
            f"{self._instructions_url}/",
            body,
            timeout=min(self._REQUEST_TIMEOUT, self.timeout),
        )

    def wait(
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
        deadline = time.monotonic() + wait_timeout
        instruction_url = f"{self._instructions_url}/{instruction_id}/"

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ACOBTimeoutError(instruction_id, wait_timeout)

            response = self._request_json(
                "GET",
                instruction_url,
                timeout=min(self._REQUEST_TIMEOUT, remaining),
            )
            status = response.get("status")
            if status in {"completed", "failed"}:
                return response
            if status not in {"pending", "processing"}:
                raise ACOBProtocolError(
                    f"Instruction {instruction_id} returned invalid status: {status!r}"
                )

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ACOBTimeoutError(instruction_id, wait_timeout)
            time.sleep(min(self.poll_interval, remaining))

    def execute(
        self,
        action: str,
        /,
        *,
        timeout: float | None = None,
        **payload: JsonValue,
    ) -> JsonValue:
        """Submit an action, wait for it, and return its browser result."""
        instruction = self.submit(action, **payload)
        instruction_id = instruction.get("id")
        if (
            isinstance(instruction_id, bool)
            or not isinstance(instruction_id, int)
            or instruction_id <= 0
        ):
            raise ACOBProtocolError("Created instruction did not contain a valid id")

        terminal = self.wait(instruction_id, timeout=timeout)
        if terminal.get("status") == "failed":
            raise ACOBInstructionError(instruction_id, terminal)
        return terminal.get("result")

    def tabs(
        self,
        operation: str,
        *,
        tid: int | None = None,
        url: str | None = None,
        timeout: float | None = None,
    ) -> JsonValue:
        """Run a list, navigate, focus, or close tab operation."""
        payload: JsonObject = {"operation": operation}
        if tid is not None:
            payload["tid"] = tid
        if url is not None:
            payload["url"] = url
        return self.execute("tabs", timeout=timeout, **payload)

    def click(
        self,
        tid: int,
        selector: str,
        *,
        timeout: float | None = None,
    ) -> JsonObject:
        """Click the center of the element matching a CSS selector."""
        return self._expect_object(
            self.execute(
                "click",
                tid=tid,
                selector=selector,
                timeout=timeout,
            ),
            "click",
        )

    def keyboard(
        self,
        tid: int,
        *,
        text: str | None = None,
        key: str | None = None,
        modifiers: Sequence[str] | None = None,
        timeout: float | None = None,
    ) -> JsonObject:
        """Insert text or dispatch one key to the focused page control."""
        payload: JsonObject = {"tid": tid}
        if text is not None:
            payload["text"] = text
        if key is not None:
            payload["key"] = key
        if modifiers is not None:
            payload["modifiers"] = list(modifiers)
        return self._expect_object(
            self.execute("keyboard", timeout=timeout, **payload),
            "keyboard",
        )

    def screenshot(
        self,
        tid: int,
        *,
        full_page: bool = False,
        timeout: float | None = None,
    ) -> ScreenshotResult:
        """Capture a tab and return its one-use download metadata."""
        result = self._expect_object(
            self.execute(
                "screenshot",
                tid=tid,
                full_page=full_page,
                timeout=timeout,
            ),
            "screenshot",
        )
        return cast(ScreenshotResult, result)

    def download_screenshot(self, download_url: str) -> bytes:
        """Consume a screenshot URL returned by a low-level execute call."""
        if not isinstance(download_url, str) or not download_url:
            raise ValueError("download_url must be a non-empty string")

        resolved_url = urljoin(f"{self.endpoint}/", download_url)
        if self._origin(urlsplit(resolved_url)) != self._origin(
            urlsplit(self.endpoint)
        ):
            raise ACOBProtocolError(
                "Screenshot download URL points to a different server"
            )
        return self._request_bytes(
            "GET",
            resolved_url,
            timeout=min(self._REQUEST_TIMEOUT, self.timeout),
            accept="image/png",
        )

    def javascript(
        self,
        tid: int,
        script: str,
        *,
        timeout: float | None = None,
    ) -> JsonValue:
        """Evaluate JavaScript in a tab and return its JSON-compatible value."""
        return self.execute(
            "javascript",
            tid=tid,
            script=script,
            timeout=timeout,
        )

    def _request_json(
        self,
        method: str,
        url: str,
        body: JsonObject | None = None,
        *,
        timeout: float,
    ) -> JsonObject:
        raw = self._request_bytes(method, url, body, timeout=timeout)
        try:
            parsed: object = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ACOBProtocolError(
                f"{method} {url} returned invalid JSON"
            ) from error
        if not isinstance(parsed, dict):
            raise ACOBProtocolError(
                f"{method} {url} returned a non-object JSON response"
            )
        return cast(JsonObject, parsed)

    def _request_bytes(
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
        request = Request(url, data=data, headers=headers, method=method)

        try:
            with urlopen(request, timeout=timeout) as response:
                return response.read()
        except HTTPError as error:
            try:
                response_body = error.read()
            finally:
                error.close()
            parsed = self._try_parse_object(response_body)
            message = self._http_error_message(parsed)
            raise ACOBHTTPError(error.code, message, parsed) from None
        except (URLError, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            raise ACOBConnectionError(
                f"Could not connect to ACOB at {self.endpoint}: {reason}"
            ) from error

    @staticmethod
    def _expect_object(result: JsonValue, action: str) -> JsonObject:
        if not isinstance(result, dict):
            raise ACOBProtocolError(f"{action} returned an invalid result")
        return result

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
            f"{message}: {'; '.join(rendered_details)}"
            if rendered_details
            else message
        )

    @staticmethod
    def _validate_bid(bid: str) -> str:
        try:
            parsed = UUID(bid)
        except (ValueError, TypeError, AttributeError) as error:
            raise ValueError(
                "bid must be a lowercase dashless UUIDv4"
            ) from error
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
