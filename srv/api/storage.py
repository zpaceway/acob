"""Local media storage: captures are written to disk and served by ACOB.

``store_media`` writes the capture bytes under ``MEDIA_ROOT`` and returns the
URL path under which this server serves them (``/api/media/<filename>``).
Captures are always hosted by the ACOB server itself; there is no external
storage service.
"""

from pathlib import Path

from django.conf import settings

MEDIA_URL_PREFIX = "/api/media/"


class StorageError(Exception):
    """Base exception for media storage failures."""


def store_media(data: bytes, filename: str) -> str:
    """Write ``data`` under ``MEDIA_ROOT`` and return its served URL path.

    The media root is created when missing. Raises ``StorageError`` when the
    bytes cannot be written.
    """
    root = Path(settings.MEDIA_ROOT)
    try:
        root.mkdir(parents=True, exist_ok=True)
        (root / filename).write_bytes(data)
    except OSError as error:
        reason = str(error) or type(error).__name__
        raise StorageError(f"Could not store the media file: {reason}") from error
    return f"{MEDIA_URL_PREFIX}{filename}"


def media_file(name: str) -> Path:
    """Return the on-disk path for a served media name.

    Only plain basenames are accepted; a name containing path separators
    resolves to a path outside the media root.
    """
    safe_name = Path(name).name
    return Path(settings.MEDIA_ROOT) / safe_name
