from django.db import transaction
from django.utils import timezone

from .models import Instruction, Reinstall

EXTENSION_REINSTALL_ERROR = "Extension reinstalled before instruction completed"


def request_reinstall(bid: str) -> Reinstall:
    with transaction.atomic():
        reinstall_request, _ = Reinstall.objects.get_or_create(bid=bid)
        Instruction.objects.filter(
            bid=bid,
            status=Instruction.Status.PROCESSING,
        ).update(
            status=Instruction.Status.FAILED,
            error=EXTENSION_REINSTALL_ERROR,
            updated_at=timezone.now(),
        )
    return reinstall_request
