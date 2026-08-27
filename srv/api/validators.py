from uuid import UUID

from django.core.exceptions import ValidationError

UUIDV4_VERSION = 4


def validate_bid(value: str) -> None:
    try:
        parsed = UUID(value)
    except (ValueError, TypeError, AttributeError) as error:
        raise ValidationError("Browser ID must be a dashless UUIDv4") from error

    if parsed.hex != value or parsed.version != UUIDV4_VERSION:
        raise ValidationError("Browser ID must be a lowercase dashless UUIDv4")
