from typing import ClassVar

from django.db import models

from .validators import validate_bid


class Instruction(models.Model):
    id: int

    class Action(models.TextChoices):
        CLICK = "click"
        JAVASCRIPT = "javascript"
        KEYBOARD = "keyboard"
        SCREENSHOT = "screenshot"
        TABS = "tabs"

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


class Screenshot(models.Model):
    id: int

    bid = models.CharField(max_length=32, db_index=True, validators=[validate_bid])
    tid = models.PositiveBigIntegerField()
    data = models.TextField()
    content_type = models.CharField(max_length=32, default="image/png")
    full_page = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
