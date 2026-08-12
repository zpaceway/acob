import base64
import binascii
import logging

from django.conf import settings
from django.db import transaction
from django.db.models import Exists
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from pydantic import ValidationError

logger = logging.getLogger(__name__)

from .models import BrowserHeartbeat, Instruction, Reinstall
from .recovery import EXTENSION_REINSTALL_ERROR, request_reinstall
from .schemas import (
    ApiModel,
    BrowserSettingsResponse,
    ErrorResponse,
    HeartbeatRequest,
    InstructionResponse,
    InstructionResultRequest,
    NextInstructionsQuery,
    RecordStartResult,
    RecordStopUploadResult,
    ReinstallAcknowledgement,
    ReinstallCommand,
    ReinstallCommandPayload,
    ReinstallResponse,
    ScreenshotResult,
    ScrollResult,
    ValidationErrorResponse,
    ValidationIssue,
    instruction_adapter,
)
from .storage import StorageError, create_storage_backend


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

    pending_reinstall = Reinstall.objects.filter(bid=bid).first()
    if pending_reinstall is not None:
        reinstall_command = JsonResponse(
            [
                ReinstallCommand(
                    payload=ReinstallCommandPayload(token=pending_reinstall.token)
                ).model_dump(mode="json")
            ],
            safe=False,
        )
        reinstall_command["Cache-Control"] = "no-store"
        return reinstall_command

    instructions: list[Instruction] = []
    no_pending_reinstall = ~Exists(Reinstall.objects.filter(bid=bid))
    while len(instructions) < query.limit:
        if Reinstall.objects.filter(bid=bid).exists():
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
            .filter(no_pending_reinstall)
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
    instruction_error = result_request.error
    if (
        instruction.action == Instruction.Action.SCREENSHOT
        and result_request.error is None
    ):
        try:
            captured = ScreenshotResult.model_validate(result)
            image = base64.b64decode(captured.data, validate=True)
        except ValidationError as error:
            return validation_error_response(error)
        except binascii.Error, ValueError:
            return error_response("Invalid screenshot data")
        try:
            url = _host_screenshot(image, instruction.payload)
        except StorageError as error:
            result = None
            instruction_error = f"Could not host the screenshot: {error}"
        else:
            result = {
                "url": url,
                "content_type": "image/png",
                "full_page": instruction.payload.get("full_page", False),
            }
    elif (
        instruction.action == Instruction.Action.RECORD_START
        and result_request.error is None
    ):
        try:
            result = RecordStartResult.model_validate(result).model_dump(mode="json")
        except ValidationError as error:
            return validation_error_response(error)
    elif (
        instruction.action == Instruction.Action.RECORD_STOP
        and result_request.error is None
    ):
        try:
            captured_recording = RecordStopUploadResult.model_validate(result)
            recording = base64.b64decode(captured_recording.data, validate=True)
        except ValidationError as error:
            logger.warning(
                "record_stop result rejected: %s",
                error.errors(include_url=False, include_context=False),
            )
            return validation_error_response(error)
        except binascii.Error, ValueError:
            logger.warning("record_stop base64 rejected")
            return error_response("Invalid recording data")
        try:
            url = _host_recording(
                recording, instruction.payload, captured_recording.content_type
            )
        except StorageError as error:
            result = None
            instruction_error = f"Could not host the recording: {error}"
        else:
            result = {
                "url": url,
                "content_type": captured_recording.content_type,
                "duration": captured_recording.duration,
                "stopped_reason": captured_recording.stopped_reason,
                "message": captured_recording.message,
            }
    elif (
        instruction.action == Instruction.Action.SCROLL and result_request.error is None
    ):
        try:
            result = ScrollResult.model_validate(result).model_dump(mode="json")
        except ValidationError as error:
            return validation_error_response(error)

    final_status = (
        Instruction.Status.FAILED if instruction_error else Instruction.Status.COMPLETED
    )
    completed_at = timezone.now()
    with transaction.atomic():
        completed = Instruction.objects.filter(
            id=instruction_id,
            bid=bid,
            status=Instruction.Status.PROCESSING,
        ).update(
            result=result,
            error=instruction_error or "",
            status=final_status,
            updated_at=completed_at,
        )

    if not completed:
        current = Instruction.objects.filter(id=instruction_id, bid=bid).first()
        if current is None:
            return error_response("Instruction not found", status=404)
        return instruction_response(current)

    instruction.result = result
    instruction.error = instruction_error or ""
    instruction.status = final_status
    instruction.updated_at = completed_at
    return instruction_response(instruction)


def _host_screenshot(image: bytes, payload: dict) -> str:
    """Upload screenshot bytes to the configured storage service."""
    backend = create_storage_backend(
        settings.STORAGE_PROVIDER,
        settings.STORAGE_CONFIG,
    )
    if backend is None:
        raise StorageError(
            "no storage service is configured; set CHIPF_ENDPOINT and "
            "CHIPF_API_KEY (or another provider's credentials)"
        )
    tid = payload.get("tid")
    filename = f"screenshot-{tid}.png" if isinstance(tid, int) else "screenshot.png"
    return backend.upload_file(image, filename, "image/png")


def _host_recording(recording: bytes, payload: dict, content_type: str) -> str:
    """Upload recording bytes to the configured storage service."""
    backend = create_storage_backend(
        settings.STORAGE_PROVIDER,
        settings.STORAGE_CONFIG,
    )
    if backend is None:
        raise StorageError(
            "no storage service is configured; set CHIPF_ENDPOINT and "
            "CHIPF_API_KEY (or another provider's credentials)"
        )
    extension = ".mp4" if content_type == "video/mp4" else ".webm"
    recording_id = payload.get("recording_id")
    filename = (
        f"recording-{recording_id}{extension}"
        if isinstance(recording_id, int)
        else f"recording{extension}"
    )
    return backend.upload_file(recording, filename, content_type)


@csrf_exempt
@require_http_methods(["GET", "POST"])
def reinstall(request: HttpRequest, bid: str) -> HttpResponse:
    if request.method == "POST":
        reinstall_request = request_reinstall(bid)
        response = model_response(
            ReinstallResponse(
                token=reinstall_request.token,
                requested_at=reinstall_request.requested_at,
            ),
            status=202,
        )
        response["Cache-Control"] = "no-store"
        return response

    pending_reinstall = Reinstall.objects.filter(bid=bid).first()
    if pending_reinstall is None:
        no_content_response = HttpResponse(status=204)
        no_content_response["Cache-Control"] = "no-store"
        return no_content_response
    pending_response = model_response(
        ReinstallResponse(
            token=pending_reinstall.token,
            requested_at=pending_reinstall.requested_at,
        )
    )
    pending_response["Cache-Control"] = "no-store"
    return pending_response


@csrf_exempt
@require_http_methods(["POST"])
def acknowledge_reinstall(request: HttpRequest, bid: str) -> HttpResponse:
    try:
        acknowledgement = ReinstallAcknowledgement.model_validate_json(request.body)
    except ValidationError as error:
        return validation_error_response(error)

    with transaction.atomic():
        reinstall_request = (
            Reinstall.objects.select_for_update().filter(bid=bid).first()
        )
        if reinstall_request is None:
            return HttpResponse(status=204)
        if reinstall_request.token != acknowledgement.token:
            return error_response("Reinstall token does not match", status=409)

        Instruction.objects.filter(
            bid=bid,
            status=Instruction.Status.PROCESSING,
        ).update(
            status=Instruction.Status.FAILED,
            error=EXTENSION_REINSTALL_ERROR,
            updated_at=timezone.now(),
        )
        reinstall_request.delete()
    return HttpResponse(status=204)


@csrf_exempt
@require_http_methods(["POST"])
def report_heartbeat(request: HttpRequest, bid: str) -> HttpResponse:
    """Store the extension's reported settings for one browser."""
    try:
        heartbeat = HeartbeatRequest.model_validate_json(request.body)
    except ValidationError as error:
        return validation_error_response(error)

    BrowserHeartbeat.objects.update_or_create(
        bid=bid,
        defaults={"settings": heartbeat.settings},
    )
    return HttpResponse(status=204)


@require_http_methods(["GET"])
def browser_settings(_request: HttpRequest, bid: str) -> JsonResponse:
    """Return the settings most recently reported by the extension."""
    stored = BrowserHeartbeat.objects.filter(bid=bid).first()
    if stored is None:
        return error_response(
            "Browser settings not found; the extension has not reported yet",
            status=404,
        )
    return model_response(
        BrowserSettingsResponse(
            settings=stored.settings,
            updated_at=stored.updated_at,
        )
    )
