"""Media storage abstraction: upload bytes and receive a public URL.

``create_storage_backend`` dispatches on the configured provider
(``STORAGE_PROVIDER``, default "chipf"), reading that provider's credentials
from its config mapping. Add another service by implementing
``StorageBackend`` and wiring it into ``create_storage_backend``.
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urljoin

import httpx


class StorageError(Exception):
    """Base exception for storage backend failures."""


class StorageConnectionError(StorageError):
    """The storage service could not be reached."""


class StorageHTTPError(StorageError):
    """The storage service rejected an upload."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"{message} (HTTP {status_code})")
        self.status_code = status_code


class StorageProtocolError(StorageError):
    """The storage service returned an unexpected response."""


class StorageBackend:
    """Upload bytes and return a public download URL."""

    def upload_file(self, data: bytes, filename: str, content_type: str) -> str:
        raise NotImplementedError


@dataclass(slots=True)
class ChipfStorageBackend(StorageBackend):
    endpoint: str
    api_key: str
    timeout: float = 30.0
    upload_path: str = "/api/files/upload"

    def upload_file(self, data: bytes, filename: str, content_type: str) -> str:
        try:
            response = httpx.post(
                f"{self.endpoint}{self.upload_path}",
                files={"file": (filename, data, content_type)},
                headers={"X-API-Key": self.api_key},
                timeout=self.timeout,
            )
        except httpx.RequestError as error:
            reason = str(error) or type(error).__name__
            raise StorageConnectionError(
                f"Could not connect to the storage service: {reason}"
            ) from error
        if response.status_code != 201:
            raise StorageHTTPError(
                response.status_code,
                _error_message(response.content),
            )
        return _upload_url(response.content, self.endpoint)


def create_storage_backend(
    provider: str,
    config: Mapping[str, Mapping[str, str]] | None = None,
) -> StorageBackend | None:
    """Return the configured storage backend, or None when unconfigured.

    ``provider`` selects the backend; ``config`` maps each provider to its
    settings (endpoint, API key, ...). Each provider requires its own
    credentials, so an unknown provider is a configuration error.
    """
    if provider != "chipf":
        raise StorageError(f"unknown storage provider: {provider!r}")
    provider_config = (config or {}).get(provider) or {}
    endpoint = provider_config.get("endpoint", "")
    api_key = provider_config.get("api_key", "")
    if not endpoint or not api_key:
        return None
    return ChipfStorageBackend(endpoint, api_key)


def _upload_url(body: bytes, endpoint: str) -> str:
    try:
        payload: object = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise StorageProtocolError(
            "The storage service returned an invalid upload response"
        ) from error
    files = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(files, list) or not files:
        raise StorageProtocolError(
            "The storage service returned an invalid upload response"
        )
    file = files[0]
    url = file.get("url") if isinstance(file, dict) else None
    if not isinstance(url, str) or not url:
        raise StorageProtocolError(
            "The storage service returned an invalid upload response"
        )
    return urljoin(f"{endpoint}/", url)


def _error_message(body: bytes) -> str:
    try:
        payload: object = json.loads(body.decode("utf-8"))
    except UnicodeDecodeError, json.JSONDecodeError:
        return "The storage service rejected the upload"
    message = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(message, str) or not message:
        return "The storage service rejected the upload"
    return message
