"""Client for the CHIPF media service: upload bytes and get a public URL."""

import json
from dataclasses import dataclass, field
from urllib.parse import urljoin

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

UPLOAD_PATH = "/api/files/upload"


class ChipfUpload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    file_id: str = Field(min_length=1)
    url: str = Field(min_length=1)
    filename: str = Field(min_length=1)
    content_type: str = Field(min_length=1)
    size: int = Field(ge=0)
    created_at: str = Field(min_length=1)


class ChipfError(Exception):
    """Base exception for CHIPF client failures."""


class ChipfConnectionError(ChipfError):
    """The CHIPF server could not be reached."""


class ChipfProtocolError(ChipfError):
    """The CHIPF server returned an unexpected response."""


class ChipfHTTPError(ChipfError):
    """The CHIPF server rejected an upload request."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"{message} (HTTP {status_code})")
        self.status_code = status_code


@dataclass(slots=True)
class ChipfClient:
    """Asynchronous client for uploading files to a CHIPF server."""

    endpoint: str
    api_key: str
    timeout: float = 60.0
    _http_client: httpx.AsyncClient | None = field(
        default=None,
        init=False,
        repr=False,
    )

    @property
    def upload_url(self) -> str:
        return f"{self.endpoint}{UPLOAD_PATH}"

    async def upload(
        self,
        filename: str,
        data: bytes,
        content_type: str,
    ) -> ChipfUpload:
        """Upload one file and return its public download URL."""
        client = self._get_http_client()
        try:
            response = await client.post(
                self.upload_url,
                files={"file": (filename, data, content_type)},
                headers={"X-API-Key": self.api_key},
            )
        except httpx.RequestError as error:
            reason = str(error) or type(error).__name__
            raise ChipfConnectionError(
                f"Could not connect to CHIPF at {self.endpoint}: {reason}"
            ) from error

        if response.status_code != 201:
            raise ChipfHTTPError(
                response.status_code,
                self._error_message(response.content),
            )
        return self._parse_upload(response.content)

    async def aclose(self) -> None:
        if self._http_client is not None:
            await self._http_client.aclose()

    def _get_http_client(self) -> httpx.AsyncClient:
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=self.timeout)
        return self._http_client

    def _parse_upload(self, body: bytes) -> ChipfUpload:
        try:
            payload: object = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ChipfProtocolError(
                "CHIPF returned an invalid upload response"
            ) from error
        files = payload.get("files") if isinstance(payload, dict) else None
        if not isinstance(files, list) or not files or not isinstance(files[0], dict):
            raise ChipfProtocolError("CHIPF returned an invalid upload response")
        try:
            upload = ChipfUpload.model_validate(files[0])
        except ValidationError as error:
            raise ChipfProtocolError(
                "CHIPF returned an invalid upload response"
            ) from error
        return upload.model_copy(
            update={"url": urljoin(f"{self.endpoint}/", upload.url)}
        )

    @staticmethod
    def _error_message(body: bytes) -> str:
        try:
            payload: object = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return "CHIPF rejected the upload"
        message = payload.get("error") if isinstance(payload, dict) else None
        if not isinstance(message, str) or not message:
            return "CHIPF rejected the upload"
        return message
