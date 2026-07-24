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
Tid = Annotated[int, Field(gt=0)]


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class JavaScriptInstruction(ApiModel):
    action: Literal["javascript"]
    tid: Tid
    script: NonEmptyString


class TabsInstruction(ApiModel):
    action: Literal["tabs"]
    operation: Literal["list", "close", "new"] = "list"
    tid: Tid | None = None

    @model_validator(mode="after")
    def validate_operation(self) -> Self:
        if self.operation == "close" and self.tid is None:
            raise ValueError("tid is required to close a tab")
        if self.operation != "close" and self.tid is not None:
            raise ValueError("tid is only valid when closing a tab")
        return self


InstructionRequest = Annotated[
    JavaScriptInstruction | TabsInstruction,
    Field(discriminator="action"),
]
instruction_adapter: TypeAdapter[InstructionRequest] = TypeAdapter(InstructionRequest)


class InstructionResultRequest(ApiModel):
    result: JsonValue = None
    error: NonEmptyString | None = None

    @model_validator(mode="after")
    def validate_result(self) -> Self:
        if self.error is not None and self.result is not None:
            raise ValueError("result and error cannot both be provided")
        return self


class InstructionResponse(ApiModel):
    id: int
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
