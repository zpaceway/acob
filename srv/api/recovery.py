from django.db import transaction
from django.utils import timezone

from .models import ExtensionReload, Instruction

EXTENSION_RELOAD_ERROR = "Extension reloaded before instruction completed"


def request_extension_reload(bid: str) -> ExtensionReload:
    with transaction.atomic():
        reload_request, _ = ExtensionReload.objects.get_or_create(bid=bid)
        Instruction.objects.filter(
            bid=bid,
            status=Instruction.Status.PROCESSING,
        ).update(
            status=Instruction.Status.FAILED,
            error=EXTENSION_RELOAD_ERROR,
            updated_at=timezone.now(),
        )
    return reload_request
