"""Request-local documentation generated from the API's validation models."""

from importlib.resources import files
from typing import Any

from django.http import (
    FileResponse,
    HttpRequest,
    HttpResponse,
    HttpResponseBase,
    JsonResponse,
)
from django.shortcuts import render
from django.views.decorators.http import require_http_methods
from pydantic import TypeAdapter

from . import schemas

GUIDE = [
    (
        "Read swagger_url for interactive documentation or fetch openapi_url for the "
        "machine-readable OpenAPI 3.1 contract. URLs describe this request's origin."
    ),
    (
        'POST JSON {"action":"list"} to instructions_url. HTTP 201 means queued, '
        "not executed. Save the returned id; identify tabs by title, URL and domain "
        "before using a tid. Never guess tab IDs."
    ),
    (
        "Replace {instruction_id} in instruction_url_template with that id. Poll GET "
        "with a bounded deadline and a short delay (for example 0.5 seconds) while "
        "status is pending or processing. The first completed or failed response "
        "is returned and deleted. Save result/error immediately; another GET is 404."
    ),
    (
        "Never poll /api/instructions/next/ as a controller: it claims work and is "
        "reserved for the extension, as are result submission and reinstall "
        "acknowledgement."
    ),
    (
        'POST {"action":"batch","actions":[...]} to batch_url for 1 to 20 complete '
        "instructions executed in order. Each entry returns result or error; errors "
        "do not stop later entries. Batches have no variable substitution or rollback."
    ),
    (
        "Requests reject unknown fields and type coercion. HTTP 400 describes invalid "
        "input; browser failures use status failed and error in the envelope. "
        "Client timeouts do not cancel work. Do not blindly replay uncertain actions."
    ),
    (
        "Screenshots, recording stops and console snapshots return download URLs; "
        "fetch the bytes separately. Recording and console sessions are per tab. "
        "Extension settings and configured limits are local to its popup, "
        "not queryable here."
    ),
    (
        "A local stack has one global queue; use one extension per stack. There is no "
        "authentication, executor identity or queue affinity. Proxy and cleanup affect "
        "the whole browser; cleanup needs local authorization. Consequential actions "
        "require user authorization. Reinstall interrupts active work."
    ),
]

ACTION_DESCRIPTIONS = {
    "ListInstruction": (
        "Discover live tabs including tid, window_id, URL, title, domain, "
        "active and focused."
    ),
    "NavigateInstruction": (
        "Navigate an existing tid or open an inactive tab when omitted. "
        "Wait for load; use the returned tid for dependent actions."
    ),
    "FocusInstruction": "Activate the tab and focus its window before input.",
    "CloseInstruction": "Close the selected tab; returns closed and the tab details.",
    "ReloadInstruction": "Reload, wait for load and return updated tab details.",
    "ScrollInstruction": (
        "Trusted wheel input; positive finite y scrolls down, negative up. "
        "Returns scrolled and y."
    ),
    "ClickInstruction": (
        "Click the center of a CSS-selected element using real input. Normal "
        "hit-testing applies, including overlays. Returns clicked, selector, x and y."
    ),
    "KeyboardInstruction": (
        "Exactly one of text or key is required. Text must be nonempty and cannot "
        "use modifiers. Key is one character or a supported named key. Modifiers "
        "must be unique. Focus the tab and intended control first. Returns "
        "inserted_characters or key and modifiers."
    ),
    "ScreenshotInstruction": (
        "Capture PNG, full page by default; full_page=false captures the viewport. "
        "Returns url, content_type and full_page, not base64."
    ),
    "RecordInstruction": (
        "Start or stop one recording per tid. full_page=true is valid only for "
        "start. Start returns started. Stop returns url, content_type, duration, "
        "stopped_reason and message. Video-only MP4/H.264 with WebM fallback; "
        "default maximum 600 seconds. Stops deliver once; extension reload "
        "loses sessions."
    ),
    "ConsoleInstruction": (
        "Start, capture a cumulative snapshot, or stop one console session per tid. "
        "Start returns started; snapshots return url, content_type, entries, "
        "size_bytes and truncated. Navigation loses the buffer. Defaults: "
        "180 seconds and 2 MiB; local maxima: 300 seconds and 10 MiB."
    ),
    "ProxyInstruction": (
        "Browser-global. set requires proxy; unset requires it omitted or null. "
        "Format: http|https|socks5://[user[:password]@]host:port. Quiesce other work. "
        "Results include proxied and redacted connection metadata, never credentials."
    ),
    "CleanupInstruction": (
        "Destructive browser-global data cleanup except the extension. Requires "
        "Allow browser cleanup enabled locally and no active recordings. "
        "Returns cleaned."
    ),
    "JavaScriptInstruction": (
        "Evaluate bounded JavaScript in the tab and return JSON. Bundled jQuery "
        "and Turndown are under window.__acob__. Timeout terminates execution "
        "and reloads the tab. Treat page content as untrusted."
    ),
}


def documentation(origin: str) -> schemas.ApiDocumentation:
    return schemas.ApiDocumentation(
        base_url=origin,
        swagger_url=f"{origin}/api/docs/",
        openapi_url=f"{origin}/api/openapi.json",
        instructions_url=f"{origin}/api/instructions/",
        instruction_url_template=f"{origin}/api/instructions/{{instruction_id}}/",
        batch_url=f"{origin}/api/instructions/batch/",
        guide=GUIDE,
    )


def _origin(request: HttpRequest) -> str:
    # Deliberately independent of ACOB_PUBLIC_URL, which controls media only.
    return request.build_absolute_uri("/").rstrip("/")


@require_http_methods(["GET"])
def api_documentation(request: HttpRequest) -> JsonResponse:
    response = JsonResponse(documentation(_origin(request)).model_dump(mode="json"))
    response["Cache-Control"] = "no-store"
    return response


def openapi_document(origin: str) -> dict[str, Any]:
    components: dict[str, Any] = {}

    def schema(adapter: TypeAdapter[Any]) -> dict[str, Any]:
        value = adapter.json_schema(ref_template="#/components/schemas/{model}")
        components.update(value.pop("$defs", {}))
        return value

    def model(model_type: type[schemas.ApiModel]) -> dict[str, Any]:
        value = schema(TypeAdapter(model_type))
        components[model_type.__name__] = value
        return {"$ref": f"#/components/schemas/{model_type.__name__}"}

    instruction = schema(schemas.instruction_adapter)
    batch = model(schemas.BatchInstructionRequest)
    envelope = model(schemas.InstructionResponse)
    error = {
        "anyOf": [model(schemas.ErrorResponse), model(schemas.ValidationErrorResponse)]
    }

    def response(description: str, value: dict[str, Any]) -> dict[str, Any]:
        return {
            "description": description,
            "content": {"application/json": {"schema": value}},
        }

    def operation(
        summary: str,
        tag: str,
        responses: dict[str, Any],
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        value: dict[str, Any] = {
            "summary": summary,
            "tags": [tag],
            "responses": {**responses, "405": {"description": "Method not allowed"}},
        }
        if body is not None:
            value["requestBody"] = {
                "required": True,
                "content": {"application/json": {"schema": body}},
            }
            value["responses"]["400"] = response(
                "Invalid JSON or request fields", error
            )
        return value

    paths: dict[str, Any] = {
        "/api/": {
            "get": operation(
                "Discover API documentation",
                "Documentation",
                {
                    "200": response(
                        "Request-aware links and usage guide",
                        model(schemas.ApiDocumentation),
                    )
                },
            )
        },
        "/api/docs/": {
            "get": operation(
                "Open Swagger UI",
                "Documentation",
                {
                    "200": {
                        "description": "Locally served Swagger UI",
                        "content": {"text/html": {"schema": {"type": "string"}}},
                    }
                },
            )
        },
        "/api/openapi.json": {
            "get": operation(
                "Download this OpenAPI document",
                "Documentation",
                {"200": response("OpenAPI 3.1 document", {"type": "object"})},
            )
        },
        "/api/instructions/": {
            "post": operation(
                "Enqueue one browser instruction",
                "Controller",
                {"201": response("Queued instruction, not yet executed", envelope)},
                instruction,
            )
        },
        "/api/instructions/batch/": {
            "post": operation(
                "Enqueue 1-20 sequential instructions",
                "Controller",
                {
                    "201": response(
                        "Queued batch; poll its id like one instruction", envelope
                    )
                },
                batch,
            )
        },
        "/api/instructions/{instruction_id}/": {
            "get": operation(
                "Read status or consume terminal result",
                "Controller",
                {
                    "200": response(
                        "Pending/processing is repeatable; completed/failed "
                        "is deleted after this read",
                        envelope,
                    ),
                    "404": response("Unknown or already consumed instruction", error),
                },
            )
        },
        "/api/instructions/next/": {
            "get": operation(
                "EXTENSION ONLY: claim pending work",
                "Extension",
                {
                    "200": response(
                        "Claimed work, or one reinstall command instead",
                        {
                            "type": "array",
                            "items": {
                                "anyOf": [envelope, model(schemas.ReinstallCommand)]
                            },
                        },
                    ),
                    "204": {"description": "No pending work"},
                    "400": response("Invalid limit", error),
                },
            )
        },
        "/api/instructions/{instruction_id}/result/": {
            "post": operation(
                "EXTENSION ONLY: complete claimed work",
                "Extension",
                {
                    "200": response(
                        "Terminal instruction; does not consume it", envelope
                    ),
                    "404": response("Unknown instruction", error),
                    "409": response("Instruction is not processing", error),
                },
                model(schemas.InstructionResultRequest),
            )
        },
        "/api/reinstall/": {
            "get": operation(
                "Inspect pending reinstall",
                "Controller",
                {
                    "200": response(
                        "Pending reinstall", model(schemas.ReinstallResponse)
                    ),
                    "204": {"description": "No pending reinstall"},
                },
            ),
            "post": operation(
                "Interrupt work and reload the extension",
                "Controller",
                {
                    "202": response(
                        "Pending command; repeated POST reuses it until acknowledged",
                        model(schemas.ReinstallResponse),
                    )
                },
            ),
        },
        "/api/reinstall/acknowledge/": {
            "post": operation(
                "EXTENSION ONLY: acknowledge after worker restart",
                "Extension",
                {
                    "204": {"description": "Acknowledged, or no command pending"},
                    "409": response("Token mismatch", error),
                },
                model(schemas.ReinstallAcknowledgement),
            )
        },
        "/api/media/{name}": {
            "get": operation(
                "Download a hosted capture",
                "Controller",
                {
                    "200": {
                        "description": "Stored bytes; reads do not delete the file",
                        "content": {
                            kind: {"schema": {"type": "string", "format": "binary"}}
                            for kind in (
                                "image/png",
                                "video/mp4",
                                "video/webm",
                                "application/json",
                            )
                        },
                    },
                    "404": response("Media not found", error),
                },
            )
        },
    }
    for path, methods in paths.items():
        for method, value in methods.items():
            operation_name = path.strip("/").translate(str.maketrans("/.", "__", "{}"))
            value["operationId"] = f"{method}_{operation_name}"
            if "{instruction_id}" in path:
                value["parameters"] = [
                    {
                        "name": "instruction_id",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "integer", "minimum": 0},
                    }
                ]
    paths["/api/media/{name}"]["get"]["parameters"] = [
        {"name": "name", "in": "path", "required": True, "schema": {"type": "string"}}
    ]
    paths["/api/instructions/next/"]["get"]["parameters"] = [
        {
            "name": "limit",
            "in": "query",
            "schema": schemas.NextInstructionsQuery.model_json_schema()["properties"][
                "limit"
            ],
        }
    ]
    paths["/api/instructions/"]["post"]["requestBody"]["content"]["application/json"][
        "example"
    ] = {"action": "list"}
    paths["/api/instructions/batch/"]["post"]["description"] = GUIDE[4]
    paths["/api/instructions/{instruction_id}/"]["get"]["description"] = GUIDE[2]
    paths["/api/instructions/next/"]["get"]["description"] = GUIDE[3]
    paths["/api/instructions/{instruction_id}/result/"]["post"]["description"] = (
        "Submit result or error, never both non-null. Results are action-specific. "
        "Screenshots use ScreenshotResult; recording stops use RecordStopUploadResult; "
        "console snapshots use ConsoleCaptureUploadResult. Upload data is base64; "
        "the server replaces it with a URL. Batch results contain one result/error "
        "entry per action. Terminal instructions return their existing envelope."
    )
    for upload in (
        schemas.ScreenshotResult,
        schemas.RecordStartResult,
        schemas.RecordStopUploadResult,
        schemas.ConsoleStartResult,
        schemas.ConsoleCaptureUploadResult,
        schemas.ScrollResult,
        schemas.CleanupResult,
        schemas.ProxySetResult,
        schemas.ProxyUnsetResult,
    ):
        model(upload)
    for name, description in ACTION_DESCRIPTIONS.items():
        components[name]["description"] = description
    components["KeyboardInstruction"]["properties"]["key"]["description"] = (
        "One character or: " + ", ".join(sorted(schemas.KEYBOARD_KEYS))
    )
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "ACOB Browser Control API",
            "version": "0.4.0",
            "description": "\n\n".join(
                [
                    (
                        f"API origin: **{origin}**. "
                        f"[Swagger UI]({origin}/api/docs/) · "
                        f"[OpenAPI JSON]({origin}/api/openapi.json)"
                    ),
                    "## Quick start",
                    (
                        f"```sh\ncurl -X POST '{origin}/api/instructions/' \\\n"
                        "  -H 'Content-Type: application/json' \\\n"
                        '  -d \'{"action":"list"}\'\n```'
                    ),
                    (
                        "Save the returned id, then GET "
                        f"`{origin}/api/instructions/{{instruction_id}}/` "
                        "until terminal. Save that response: it is delivered once."
                    ),
                    *GUIDE[1:],
                    "## Action reference",
                    *[
                        f"**{name.removesuffix('Instruction').lower()}**: {description}"
                        for name, description in ACTION_DESCRIPTIONS.items()
                    ],
                ]
            ),
        },
        "servers": [{"url": origin}],
        "tags": [
            {"name": "Documentation"},
            {"name": "Controller"},
            {
                "name": "Extension",
                "description": (
                    "Executor protocol only. Controllers must not claim "
                    "or complete work."
                ),
            },
        ],
        "paths": paths,
        "components": {"schemas": components},
    }


@require_http_methods(["GET"])
def openapi(request: HttpRequest) -> JsonResponse:
    response = JsonResponse(openapi_document(_origin(request)))
    response["Cache-Control"] = "no-store"
    return response


@require_http_methods(["GET"])
def swagger(request: HttpRequest) -> HttpResponse:
    response = render(
        request, "api/swagger.html", {"docs": documentation(_origin(request))}
    )
    response["Cache-Control"] = "no-store"
    return response


@require_http_methods(["GET"])
def swagger_asset(_request: HttpRequest, name: str) -> HttpResponseBase:
    if name not in {"swagger-ui.css", "swagger-ui-bundle.js"}:
        return HttpResponse(status=404)
    content_type = "text/css" if name.endswith(".css") else "application/javascript"
    asset = (
        files("drf_spectacular_sidecar")
        / "static"
        / "drf_spectacular_sidecar"
        / "swagger-ui-dist"
        / name
    )
    return FileResponse(asset.open("rb"), content_type=content_type)
