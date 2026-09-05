from datetime import datetime
from typing import Annotated, Literal, Self
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    TypeAdapter,
    model_validator,
)

from .models import Instruction

NonEmptyString = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1),
]
NonEmptyText = Annotated[str, StringConstraints(min_length=1)]
Tid = Annotated[int, Field(gt=0)]
ScrollY = Annotated[float, Field(allow_inf_nan=False)]
MAX_SCREENSHOT_BASE64_LENGTH = 30 * 1024 * 1024
MAX_RECORDING_BASE64_LENGTH = 512 * 1024 * 1024
# Console buffers are capped raw (10 MiB max setting); base64 inflates by 4/3.
MAX_CONSOLE_BASE64_LENGTH = 14 * 1024 * 1024
MAX_RECORDING_DURATION_SECONDS = 300
MAX_INSTRUCTION_CLAIM_LIMIT = 20
MAX_BATCH_ACTIONS = 20
MAX_PROXY_LENGTH = 2048
MAX_PROXY_HOST_LENGTH = 253
MAX_PROXY_PORT = 65535
MIN_PROXY_PORT = 1
MAX_PROXY_CREDENTIAL_LENGTH = 255
PROXY_SCHEMES = {"http", "https", "socks5"}

KEYBOARD_KEYS = {
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "Backspace",
    "Delete",
    "End",
    "Enter",
    "Escape",
    "Home",
    "PageDown",
    "PageUp",
    "Space",
    "Tab",
}


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class JavaScriptInstruction(ApiModel):
    action: Literal["javascript"]
    tid: Tid
    script: NonEmptyString


class ClickInstruction(ApiModel):
    action: Literal["click"]
    tid: Tid
    selector: NonEmptyString


class KeyboardInstruction(ApiModel):
    action: Literal["keyboard"]
    tid: Tid
    text: NonEmptyText | None = None
    key: NonEmptyString | None = None
    modifiers: list[Literal["alt", "ctrl", "meta", "shift"]] = Field(
        default_factory=list
    )

    @model_validator(mode="after")
    def validate_input(self) -> Self:
        if (self.text is None) == (self.key is None):
            raise ValueError("exactly one of text or key is required")
        if self.text is not None and self.modifiers:
            raise ValueError("modifiers are only valid with key input")
        if len(self.modifiers) != len(set(self.modifiers)):
            raise ValueError("modifiers cannot contain duplicates")
        if (
            self.key is not None
            and self.key not in KEYBOARD_KEYS
            and len(self.key) != 1
        ):
            raise ValueError("key must be a supported named key or one character")
        return self


class ScreenshotInstruction(ApiModel):
    action: Literal["screenshot"]
    tid: Tid
    full_page: bool = True


def _parse_proxy_string(value: str) -> tuple[str, str, int, bool]:
    """Parse and validate a proxy string, returning scheme/host/port/auth.

    Accepted format: ``scheme://[user[:password]@]host:port`` where scheme is
    one of http, https, or socks5. The port is always required.
    """
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise ValueError(f"Invalid proxy string: {error}") from error
    scheme = parsed.scheme.lower()
    if scheme not in PROXY_SCHEMES:
        raise ValueError(
            "Invalid proxy string: scheme must be one of http, https, socks5"
        )
    host = parsed.hostname
    if not host or len(host) > MAX_PROXY_HOST_LENGTH:
        raise ValueError("Invalid proxy string: host is required")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError(f"Invalid proxy string: {error}") from error
    if port is None or not MIN_PROXY_PORT <= port <= MAX_PROXY_PORT:
        raise ValueError("Invalid proxy string: port must be 1-65535")
    if parsed.query or parsed.fragment:
        raise ValueError("Invalid proxy string: query and fragment are not allowed")
    path = parsed.path
    if path not in ("", "/"):
        raise ValueError("Invalid proxy string: path is not allowed")
    username = parsed.username
    password = parsed.password
    if username is not None and not 1 <= len(username) <= MAX_PROXY_CREDENTIAL_LENGTH:
        raise ValueError("Invalid proxy string: invalid credentials")
    if password is not None and not len(password) <= MAX_PROXY_CREDENTIAL_LENGTH:
        raise ValueError("Invalid proxy string: invalid credentials")
    authenticated = username is not None
    return scheme, host, port, authenticated


ProxyString = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_PROXY_LENGTH),
]


class ProxyInstruction(ApiModel):
    action: Literal["proxy"]
    method: Literal["set", "unset"]
    proxy: ProxyString | None = None

    @model_validator(mode="after")
    def validate_proxy(self) -> Self:
        if self.method == "set":
            if self.proxy is None:
                raise ValueError("proxy is required when method is 'set'")
            _parse_proxy_string(self.proxy)
        elif self.proxy is not None:
            raise ValueError("proxy must not be provided when method is 'unset'")
        return self


class RecordInstruction(ApiModel):
    action: Literal["record"]
    method: Literal["start", "stop"]
    tid: Tid
    full_page: bool = False

    @model_validator(mode="after")
    def validate_record(self) -> Self:
        if self.method == "stop" and self.full_page:
            raise ValueError("full_page is only valid when method is 'start'")
        return self


class ConsoleInstruction(ApiModel):
    action: Literal["console"]
    method: Literal["start", "capture", "stop"]
    tid: Tid


class ListInstruction(ApiModel):
    action: Literal["list"]


class CloseInstruction(ApiModel):
    action: Literal["close"]
    tid: Tid


class FocusInstruction(ApiModel):
    action: Literal["focus"]
    tid: Tid


class NavigateInstruction(ApiModel):
    action: Literal["navigate"]
    url: NonEmptyString
    tid: Tid | None = None


class ReloadInstruction(ApiModel):
    action: Literal["reload"]
    tid: Tid


class ScrollInstruction(ApiModel):
    action: Literal["scroll"]
    tid: Tid
    y: ScrollY


InstructionRequest = Annotated[
    CloseInstruction
    | ClickInstruction
    | ConsoleInstruction
    | FocusInstruction
    | JavaScriptInstruction
    | KeyboardInstruction
    | ListInstruction
    | NavigateInstruction
    | ProxyInstruction
    | RecordInstruction
    | ReloadInstruction
    | ScreenshotInstruction
    | ScrollInstruction,
    Field(discriminator="action"),
]
instruction_adapter: TypeAdapter[InstructionRequest] = TypeAdapter(InstructionRequest)


class BatchInstructionRequest(ApiModel):
    """A list of instructions that the browser executes sequentially."""

    action: Literal["batch"]
    actions: list[InstructionRequest] = Field(
        min_length=1,
        max_length=MAX_BATCH_ACTIONS,
    )


class ScreenshotResult(ApiModel):
    data: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=MAX_SCREENSHOT_BASE64_LENGTH,
        ),
    ]


class RecordStartResult(ApiModel):
    started: Literal[True]


class ConsoleStartResult(ApiModel):
    started: Literal[True]


class ConsoleCaptureUploadResult(ApiModel):
    data: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=MAX_CONSOLE_BASE64_LENGTH,
        ),
    ]
    content_type: Literal["application/json"]
    entries: Annotated[int, Field(ge=0)]
    size_bytes: Annotated[int, Field(ge=0)]
    truncated: bool


class ProxySetResult(ApiModel):
    proxied: Literal[True]
    scheme: Literal["http", "https", "socks5"]
    host: NonEmptyString
    port: Annotated[int, Field(ge=MIN_PROXY_PORT, le=MAX_PROXY_PORT)]
    authenticated: bool


class ProxyUnsetResult(ApiModel):
    proxied: Literal[False]


class RecordStopUploadResult(ApiModel):
    data: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=MAX_RECORDING_BASE64_LENGTH,
        ),
    ]
    content_type: Literal["video/mp4", "video/webm"]
    duration: Annotated[
        float,
        Field(gt=0, le=MAX_RECORDING_DURATION_SECONDS, allow_inf_nan=False),
    ]
    stopped_reason: Literal["user", "max_duration"]
    message: NonEmptyString


class ScrollResult(ApiModel):
    scrolled: Literal[True]
    y: ScrollY


class InstructionResultRequest(ApiModel):
    result: JsonValue = None
    error: NonEmptyString | None = None

    @model_validator(mode="after")
    def validate_result(self) -> Self:
        if self.error is not None and self.result is not None:
            raise ValueError("result and error cannot both be provided")
        return self


BatchResultList = Annotated[
    list[InstructionResultRequest],
    Field(min_length=1, max_length=MAX_BATCH_ACTIONS),
]
batch_results_adapter: TypeAdapter[BatchResultList] = TypeAdapter(BatchResultList)


class NextInstructionsQuery(ApiModel):
    limit: int = Field(default=1, ge=1, le=MAX_INSTRUCTION_CLAIM_LIMIT)


class ReinstallAcknowledgement(ApiModel):
    token: UUID


class ReinstallResponse(ApiModel):
    token: UUID
    status: Literal["pending"] = "pending"
    requested_at: datetime


class ReinstallCommandPayload(ApiModel):
    token: UUID


# Delivered by the claim route in place of queued work, so it never collides
# with a stored instruction action.
class ReinstallCommand(ApiModel):
    action: Literal["reinstall"] = "reinstall"
    payload: ReinstallCommandPayload


class InstructionResponse(ApiModel):
    id: int
    bid: str
    # Stored instructions can outlive the request schema that accepted them.
    action: str
    payload: dict[str, JsonValue]
    status: Literal["pending", "processing", "completed", "failed"]
    result: JsonValue = None
    error: str | None = None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_instruction(cls, instruction: Instruction) -> Self:
        return cls.model_validate(
            {
                "id": instruction.id,
                "bid": instruction.bid,
                "action": instruction.action,
                "payload": instruction.payload,
                "status": instruction.status,
                "result": instruction.result,
                "error": instruction.error or None,
                "created_at": instruction.created_at,
                "updated_at": instruction.updated_at,
            }
        )


class ErrorResponse(ApiModel):
    error: str


class HeartbeatRequest(ApiModel):
    settings: dict[str, JsonValue]


class BrowserSettingsResponse(ApiModel):
    settings: dict[str, JsonValue]
    updated_at: datetime


class ValidationIssue(ApiModel):
    field: str
    message: str
    type: str


class ValidationErrorResponse(ApiModel):
    error: Literal["Invalid request"] = "Invalid request"
    details: list[ValidationIssue]
