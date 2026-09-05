from typing import ClassVar, override
from uuid import uuid4

from django.db import models

from .validators import validate_bid


class Instruction(models.Model):
    id: int

    class Action(models.TextChoices):
        BATCH = "batch"
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

    class Status(models.TextChoices):
        PENDING = "pending"
        PROCESSING = "processing"
        COMPLETED = "completed"
        FAILED = "failed"

    bid = models.CharField(max_length=32, db_index=True, validators=[validate_bid])
    action = models.CharField(max_length=16, choices=Action)
    payload = models.JSONField(default=dict)
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
    bid = models.CharField(
        max_length=32,
        unique=True,
        validators=[validate_bid],
    )
    token = models.UUIDField(default=uuid4, editable=False, unique=True)
    requested_at = models.DateTimeField(auto_now_add=True)

    @override
    def __str__(self) -> str:
        return f"reinstall {self.bid}"


class BrowserHeartbeat(models.Model):
    """Most recently reported extension settings for one browser."""

    bid = models.CharField(
        max_length=32,
        unique=True,
        validators=[validate_bid],
    )
    settings = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)

    @override
    def __str__(self) -> str:
        return f"heartbeat {self.bid}"
