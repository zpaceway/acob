from datetime import datetime
from typing import Annotated, Literal, Self
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
RecordingId = Annotated[int, Field(gt=0)]
ScrollY = Annotated[float, Field(allow_inf_nan=False)]
MAX_SCREENSHOT_BASE64_LENGTH = 30 * 1024 * 1024
MAX_RECORDING_BASE64_LENGTH = 60 * 1024 * 1024
MAX_RECORDING_DURATION_SECONDS = 300
MAX_INSTRUCTION_CLAIM_LIMIT = 20

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
    full_page: bool = False


class RecordStartInstruction(ApiModel):
    action: Literal["record_start"]
    tid: Tid
    full_page: bool = False


class RecordStopInstruction(ApiModel):
    action: Literal["record_stop"]
    recording_id: RecordingId


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
    | FocusInstruction
    | JavaScriptInstruction
    | KeyboardInstruction
    | ListInstruction
    | NavigateInstruction
    | RecordStartInstruction
    | RecordStopInstruction
    | ReloadInstruction
    | ScreenshotInstruction
    | ScrollInstruction,
    Field(discriminator="action"),
]
instruction_adapter: TypeAdapter[InstructionRequest] = TypeAdapter(InstructionRequest)


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
    recording_id: RecordingId
    started: Literal[True]


class RecordStopUploadResult(ApiModel):
    data: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=MAX_RECORDING_BASE64_LENGTH,
        ),
    ]
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
