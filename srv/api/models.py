from typing import ClassVar, override
from uuid import uuid4

from django.db import models


class Instruction(models.Model):
    id: int

    class Action(models.TextChoices):
        BATCH = "batch"
        CLEANUP = "cleanup"
        CLICK = "click"
        CLOSE = "close"
        CONSOLE = "console"
        FOCUS = "focus"
        JAVASCRIPT = "javascript"
        KEYBOARD = "keyboard"
        LIST = "list"
        NAVIGATE = "navigate"
        PROXY = "proxy"
        RECORD = "record"
        RELOAD = "reload"
        SCREENSHOT = "screenshot"
        SCROLL = "scroll"
        WAIT = "wait"

    class Status(models.TextChoices):
        PENDING = "pending"
        PROCESSING = "processing"
        COMPLETED = "completed"
        FAILED = "failed"

    action = models.CharField(max_length=16, choices=Action)
    payload = models.JSONField(default=dict)
    bid = models.CharField(  # noqa: DJ001
        max_length=32, null=True, blank=True, db_index=True
    )
    status = models.CharField(
        max_length=16,
        choices=Status,
        default=Status.PENDING,
    )
    result = models.JSONField(null=True, blank=True)
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering: ClassVar[list[str]] = ["created_at"]

    @override
    def __str__(self) -> str:
        return f"{self.action} ({self.id})"


class Reinstall(models.Model):
    token = models.UUIDField(default=uuid4, editable=False, unique=True)
    requested_at = models.DateTimeField(auto_now_add=True)

    @override
    def __str__(self) -> str:
        return f"reinstall {self.token}"
