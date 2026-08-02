import base64
import binascii

from django.db import transaction
from django.db.models import Exists
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from pydantic import ValidationError

from .models import ExtensionReload, Instruction, Screenshot
from .recovery import EXTENSION_RELOAD_ERROR, request_extension_reload
from .schemas import (
    ApiModel,
    ErrorResponse,
    ExtensionReloadAcknowledgement,
    ExtensionReloadResponse,
    InstructionResponse,
    InstructionResultRequest,
    NextInstructionsQuery,
    ScreenshotResult,
    ScrollResult,
    ValidationErrorResponse,
    ValidationIssue,
    instruction_adapter,
)


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
    response = model_response(
        InstructionResponse.from_instruction(instruction),
        status=status,
    )
    response["Cache-Control"] = "no-store"
    return response


def instruction_list_response(instructions: list[Instruction]) -> JsonResponse:
    response = JsonResponse(
        [
            InstructionResponse.from_instruction(instruction).model_dump(mode="json")
            for instruction in instructions
        ],
        safe=False,
    )
    response["Cache-Control"] = "no-store"
    return response


@csrf_exempt
@require_http_methods(["POST"])
def create_instruction(request: HttpRequest, bid: str) -> JsonResponse:
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
        bid=bid,
        action=request_model.action,
        payload=payload,
    )
    return instruction_response(instruction, status=201)


@require_http_methods(["GET"])
def instruction_detail(
    _request: HttpRequest,
    bid: str,
    instruction_id: int,
) -> JsonResponse:
    instruction = Instruction.objects.filter(id=instruction_id, bid=bid).first()
    if instruction is None:
        return error_response("Instruction not found", status=404)

    response = instruction_response(instruction)
    if instruction.status not in {
        Instruction.Status.COMPLETED,
        Instruction.Status.FAILED,
    }:
        return response

    deleted, _ = Instruction.objects.filter(
        id=instruction.id,
        bid=bid,
        status=instruction.status,
    ).delete()
    if not deleted:
        return error_response("Instruction not found", status=404)
    return response


@require_http_methods(["GET"])
def next_instructions(request: HttpRequest, bid: str) -> HttpResponse:
    try:
        query = NextInstructionsQuery.model_validate_strings(request.GET.dict())
    except ValidationError as error:
        return validation_error_response(error)

    instructions: list[Instruction] = []
    no_pending_reload = ~Exists(ExtensionReload.objects.filter(bid=bid))
    while len(instructions) < query.limit:
        if ExtensionReload.objects.filter(bid=bid).exists():
            break
        candidate = (
            Instruction.objects.filter(
                bid=bid,
                status=Instruction.Status.PENDING,
            )
            .values("id")
            .first()
        )
        if candidate is None:
            break

        claimed = (
            Instruction.objects.filter(
                id=candidate["id"],
                bid=bid,
                status=Instruction.Status.PENDING,
            )
            .filter(no_pending_reload)
            .update(
                status=Instruction.Status.PROCESSING,
                updated_at=timezone.now(),
            )
        )
        if claimed:
            instructions.append(Instruction.objects.get(id=candidate["id"]))

    if instructions:
        return instruction_list_response(instructions)

    response = HttpResponse(status=204)
    response["Cache-Control"] = "no-store"
    return response


@csrf_exempt
@require_http_methods(["POST"])
def complete_instruction(
    request: HttpRequest,
    bid: str,
    instruction_id: int,
) -> JsonResponse:
    instruction = Instruction.objects.filter(id=instruction_id, bid=bid).first()
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

    result = result_request.result
    captured_screenshot = None
    if (
        instruction.action == Instruction.Action.SCREENSHOT
        and result_request.error is None
    ):
        try:
            captured_screenshot = ScreenshotResult.model_validate(result)
            base64.b64decode(captured_screenshot.data, validate=True)
        except ValidationError as error:
            return validation_error_response(error)
        except binascii.Error, ValueError:
            return error_response("Invalid screenshot data")
    elif (
        instruction.action == Instruction.Action.SCROLL and result_request.error is None
    ):
        try:
            result = ScrollResult.model_validate(result).model_dump(mode="json")
        except ValidationError as error:
            return validation_error_response(error)

    final_status = (
        Instruction.Status.FAILED
        if result_request.error
        else Instruction.Status.COMPLETED
    )
    completed_at = timezone.now()
    screenshot = None
    with transaction.atomic():
        if captured_screenshot is not None:
            screenshot = Screenshot.objects.create(
                bid=bid,
                tid=instruction.payload["tid"],
                data=captured_screenshot.data,
                full_page=instruction.payload.get("full_page", False),
            )
            result = {
                "download_url": reverse(
                    "download-screenshot",
                    kwargs={"bid": bid, "screenshot_id": screenshot.id},
                ),
                "content_type": screenshot.content_type,
                "full_page": screenshot.full_page,
                "single_use": True,
                "tid": screenshot.tid,
            }

        completed = Instruction.objects.filter(
            id=instruction_id,
            bid=bid,
            status=Instruction.Status.PROCESSING,
        ).update(
            result=result,
            error=result_request.error or "",
            status=final_status,
            updated_at=completed_at,
        )
        if not completed and screenshot is not None:
            screenshot.delete()

    if not completed:
        current = Instruction.objects.filter(id=instruction_id, bid=bid).first()
        if current is None:
            return error_response("Instruction not found", status=404)
        return instruction_response(current)

    instruction.result = result
    instruction.error = result_request.error or ""
    instruction.status = final_status
    instruction.updated_at = completed_at
    return instruction_response(instruction)


@require_http_methods(["GET"])
def download_screenshot(
    _request: HttpRequest,
    bid: str,
    screenshot_id: int,
) -> HttpResponse:
    screenshot = Screenshot.objects.filter(id=screenshot_id, bid=bid).first()
    if screenshot is None:
        return error_response("Screenshot not found", status=404)

    try:
        image = base64.b64decode(screenshot.data, validate=True)
    except binascii.Error, ValueError:
        screenshot.delete()
        return error_response("Screenshot data is invalid", status=500)

    screenshot.delete()

    response = HttpResponse(image, content_type=screenshot.content_type)
    response["Content-Disposition"] = (
        f'attachment; filename="acob-screenshot-{screenshot_id}.png"'
    )
    response["Cache-Control"] = "no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response


@csrf_exempt
@require_http_methods(["GET", "POST"])
def extension_reload(request: HttpRequest, bid: str) -> HttpResponse:
    if request.method == "POST":
        reload_request = request_extension_reload(bid)
        response = model_response(
            ExtensionReloadResponse(
                token=reload_request.token,
                requested_at=reload_request.requested_at,
            ),
            status=202,
        )
        response["Cache-Control"] = "no-store"
        return response

    pending_reload = ExtensionReload.objects.filter(bid=bid).first()
    if pending_reload is None:
        no_content_response = HttpResponse(status=204)
        no_content_response["Cache-Control"] = "no-store"
        return no_content_response
    pending_response = model_response(
        ExtensionReloadResponse(
            token=pending_reload.token,
            requested_at=pending_reload.requested_at,
        )
    )
    pending_response["Cache-Control"] = "no-store"
    return pending_response


@csrf_exempt
@require_http_methods(["POST"])
def acknowledge_extension_reload(request: HttpRequest, bid: str) -> HttpResponse:
    try:
        acknowledgement = ExtensionReloadAcknowledgement.model_validate_json(
            request.body
        )
    except ValidationError as error:
        return validation_error_response(error)

    with transaction.atomic():
        reload_request = (
            ExtensionReload.objects.select_for_update().filter(bid=bid).first()
        )
        if reload_request is None:
            return HttpResponse(status=204)
        if reload_request.token != acknowledgement.token:
            return error_response("Extension reload token does not match", status=409)

        Instruction.objects.filter(
            bid=bid,
            status=Instruction.Status.PROCESSING,
        ).update(
            status=Instruction.Status.FAILED,
            error=EXTENSION_RELOAD_ERROR,
            updated_at=timezone.now(),
        )
        reload_request.delete()
    return HttpResponse(status=204)
