from datetime import datetime
from typing import Annotated, Literal, Self

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
MAX_SCREENSHOT_BASE64_LENGTH = 30 * 1024 * 1024
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


class TabsInstruction(ApiModel):
    action: Literal["tabs"]
    operation: Literal["list", "close", "focus", "navigate"]
    tid: Tid | None = None
    url: NonEmptyString | None = None

    @model_validator(mode="after")
    def validate_operation(self) -> Self:
        targeted_operations = {"close", "focus"}
        if self.operation in targeted_operations and self.tid is None:
            raise ValueError(f"tid is required to {self.operation} a tab")
        if (
            self.operation not in targeted_operations | {"navigate"}
            and self.tid is not None
        ):
            raise ValueError(
                "tid is only valid when closing, focusing, or navigating a tab"
            )
        if self.operation == "navigate" and self.url is None:
            raise ValueError("url is required to navigate")
        if self.operation != "navigate" and self.url is not None:
            raise ValueError("url is only valid when navigating")
        return self


InstructionRequest = Annotated[
    ClickInstruction
    | JavaScriptInstruction
    | KeyboardInstruction
    | ScreenshotInstruction
    | TabsInstruction,
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


class ValidationIssue(ApiModel):
    field: str
    message: str
    type: str


class ValidationErrorResponse(ApiModel):
    error: Literal["Invalid request"] = "Invalid request"
    details: list[ValidationIssue]
