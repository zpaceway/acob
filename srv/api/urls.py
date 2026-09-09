from django.urls import path

from . import documentation, views

urlpatterns = [
    path("", documentation.api_documentation, name="api-documentation"),
    path("docs/", documentation.swagger, name="swagger"),
    path("docs/assets/<str:name>", documentation.swagger_asset, name="swagger-asset"),
    path("openapi.json", documentation.openapi, name="openapi"),
    path(
        "reinstall/",
        views.reinstall,
        name="reinstall",
    ),
    path(
        "reinstall/acknowledge/",
        views.acknowledge_reinstall,
        name="acknowledge-reinstall",
    ),
    path(
        "instructions/",
        views.create_instruction,
        name="create-instruction",
    ),
    path(
        "instructions/batch/",
        views.create_batch_instruction,
        name="create-batch-instruction",
    ),
    path(
        "instructions/next/",
        views.next_instructions,
        name="next-instructions",
    ),
    path(
        "instructions/<int:instruction_id>/",
        views.instruction_detail,
        name="instruction-detail",
    ),
    path(
        "instructions/<int:instruction_id>/result/",
        views.complete_instruction,
        name="complete-instruction",
    ),
    path(
        "media/<str:name>",
        views.serve_media,
        name="serve-media",
    ),
]
