from django.core.exceptions import ValidationError
from django.urls import path, register_converter

from . import views
from .validators import validate_bid


class BrowserIdConverter:
    regex = "[0-9a-f]{32}"

    def to_python(self, value: str) -> str:
        try:
            validate_bid(value)
        except ValidationError as error:
            raise ValueError from error
        return value

    def to_url(self, value: str) -> str:
        return value


register_converter(BrowserIdConverter, "bid")

urlpatterns = [
    path(
        "browsers/<bid:bid>/extension/reload/",
        views.extension_reload,
        name="extension-reload",
    ),
    path(
        "browsers/<bid:bid>/extension/reload/acknowledge/",
        views.acknowledge_extension_reload,
        name="acknowledge-extension-reload",
    ),
    path(
        "browsers/<bid:bid>/instructions/",
        views.create_instruction,
        name="create-instruction",
    ),
    path(
        "browsers/<bid:bid>/instructions/next/",
        views.next_instructions,
        name="next-instructions",
    ),
    path(
        "browsers/<bid:bid>/instructions/<int:instruction_id>/",
        views.instruction_detail,
        name="instruction-detail",
    ),
    path(
        "browsers/<bid:bid>/instructions/<int:instruction_id>/result/",
        views.complete_instruction,
        name="complete-instruction",
    ),
    path(
        "browsers/<bid:bid>/screenshots/<int:screenshot_id>/",
        views.download_screenshot,
        name="download-screenshot",
    ),
]
