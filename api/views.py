from datetime import timedelta

from django.db.models import Q
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from pydantic import ValidationError

from .models import Instruction
from .schemas import (
    ApiModel,
    ErrorResponse,
    InstructionResponse,
    InstructionResultRequest,
    ValidationErrorResponse,
    ValidationIssue,
    instruction_adapter,
)

CLAIM_TIMEOUT = timedelta(seconds=60)


def model_response(model: ApiModel, status: int = 200) -> JsonResponse:
    return JsonResponse(model.model_dump(mode="json"), status=status)


def error_response(message: str, status: int = 400) -> JsonResponse:
    return model_response(ErrorResponse(error=message), status=status)


def validation_error_response(error: ValidationError) -> JsonResponse:
    details = [
        ValidationIssue(
            field=".".join(str(part) for part in issue["loc"]) or "body",
            message=issue["msg"],
            type=issue["type"],
        )
        for issue in error.errors(include_url=False, include_context=False)
    ]
    return model_response(ValidationErrorResponse(details=details), status=400)


def instruction_response(
    instruction: Instruction,
    status: int = 200,
) -> JsonResponse:
    return model_response(
        InstructionResponse.from_instruction(instruction),
        status=status,
    )


@csrf_exempt
@require_http_methods(["POST"])
def create_instruction(request: HttpRequest) -> JsonResponse:
    try:
        request_model = instruction_adapter.validate_json(request.body)
    except ValidationError as error:
        return validation_error_response(error)

    payload = request_model.model_dump(
        mode="json",
        exclude={"action"},
        exclude_none=True,
    )
    instruction = Instruction.objects.create(
        action=request_model.action,
        payload=payload,
    )
    return instruction_response(instruction, status=201)


@require_http_methods(["GET"])
def instruction_detail(
    _request: HttpRequest,
    instruction_id: int,
) -> JsonResponse:
    instruction = Instruction.objects.filter(id=instruction_id).first()
    if instruction is None:
        return error_response("Instruction not found", status=404)

    return instruction_response(instruction)


@require_http_methods(["GET"])
def next_instruction(_request: HttpRequest) -> HttpResponse:
    while True:
        stale_before = timezone.now() - CLAIM_TIMEOUT
        candidate = (
            Instruction.objects.filter(
                Q(status=Instruction.Status.PENDING)
                | Q(
                    status=Instruction.Status.PROCESSING,
                    updated_at__lt=stale_before,
                )
            )
            .values("id", "status", "updated_at")
            .first()
        )
        if candidate is None:
            return HttpResponse(status=204)

        claim = Q(id=candidate["id"], status=candidate["status"])
        if candidate["status"] == Instruction.Status.PROCESSING:
            claim &= Q(updated_at=candidate["updated_at"])

        claimed = Instruction.objects.filter(claim).update(
            status=Instruction.Status.PROCESSING,
            updated_at=timezone.now(),
        )
        if claimed:
            instruction = Instruction.objects.get(id=candidate["id"])
            break

    return instruction_response(instruction)


@csrf_exempt
@require_http_methods(["POST"])
def complete_instruction(
    request: HttpRequest,
    instruction_id: int,
) -> JsonResponse:
    instruction = Instruction.objects.filter(id=instruction_id).first()
    if instruction is None:
        return error_response("Instruction not found", status=404)

    try:
        result_request = InstructionResultRequest.model_validate_json(request.body)
    except ValidationError as error:
        return validation_error_response(error)

    if instruction.status in {
        Instruction.Status.COMPLETED,
        Instruction.Status.FAILED,
    }:
        return instruction_response(instruction)
    if instruction.status != Instruction.Status.PROCESSING:
        return error_response("Instruction is not processing", status=409)

    instruction.result = result_request.result
    instruction.error = result_request.error or ""
    instruction.status = (
        Instruction.Status.FAILED
        if result_request.error
        else Instruction.Status.COMPLETED
    )
    instruction.save(update_fields=["result", "error", "status", "updated_at"])
    return instruction_response(instruction)
