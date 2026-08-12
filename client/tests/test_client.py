import asyncio
import json
import unittest
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, call, patch

import httpx

from acob import (
    DEFAULT_ENDPOINT,
    ACOBClient,
    ACOBConnectionError,
    ACOBError,
    ACOBHTTPError,
    ACOBInstructionError,
    ACOBProtocolError,
    ACOBTimeoutError,
    BrowserSettings,
    ClickResult,
    ClosedTab,
    KeyboardKeyResult,
    KeyboardTextResult,
    ListedTab,
    RecordingStart,
    RecordingStop,
    ReinstallResult,
    Screenshot,
    ScrollResult,
    Tab,
)

if TYPE_CHECKING:

    async def _check_return_types(client: ACOBClient) -> None:
        _listed: list[ListedTab] = await client.list()
        _navigated: Tab = await client.navigate("https://example.com")
        _focused: Tab = await client.focus(1)
        _closed: ClosedTab = await client.close(1)
        _reloaded: Tab = await client.reload(1)
        _scrolled: ScrollResult = await client.scroll(1, 500)
        _clicked: ClickResult = await client.click(1, "button")
        _inserted: KeyboardTextResult = await client.keyboard(1, text="ACOB")
        _pressed: KeyboardKeyResult = await client.keyboard(1, key="Enter")
        _screenshot: Screenshot = await client.screenshot(1)
        _record_start: RecordingStart = await client.record_start(1)
        _record_stop: RecordingStop = await client.record_stop(1)
        _settings: BrowserSettings = await client.settings()
        _javascript: int = await client.javascript(1, "1")
        _reinstall: ReinstallResult = await client.reinstall()


class FailingTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)


class ACOBClientTests(unittest.IsolatedAsyncioTestCase):
    BID = "0123456789ab4def8123456789abcdef"

    def make_client(self, endpoint="http://acob.test/"):
        client = ACOBClient(
            self.BID,
            endpoint=endpoint,
            timeout=5,
            poll_interval=0.01,
        )
        self.addAsyncCleanup(client.aclose)
        return client

    @staticmethod
    def add_responses(client, responses):
        requests = []
        response_iterator = iter(responses)

        def handler(request):
            requests.append(request)
            status_code, body = next(response_iterator)
            if isinstance(body, bytes):
                return httpx.Response(status_code, content=body)
            return httpx.Response(
                status_code,
                content=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )

        client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        return requests

    async def test_initializes_with_default_endpoint_and_validates_configuration(self):
        client = ACOBClient(self.BID)
        self.addAsyncCleanup(client.aclose)

        self.assertEqual(client.bid, self.BID)
        self.assertEqual(client.endpoint, DEFAULT_ENDPOINT)

        invalid_bids = (
            "not-a-uuid",
            "00000000000000000000000000000000",
            "01234567-89ab-4def-8123-456789abcdef",
            "0123456789AB4DEF8123456789ABCDEF",
        )
        for bid in invalid_bids:
            with self.subTest(bid=bid), self.assertRaises(ValueError):
                ACOBClient(bid)

        for endpoint in ("", "acob.test", "ftp://acob.test", "http://acob.test?q=1"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                ACOBClient(self.BID, endpoint)

    async def test_list_submits_and_consumes_terminal_response(self):
        tab = {
            "tid": 12,
            "window_id": 3,
            "active": True,
            "focused": True,
            "title": "Example",
            "url": "https://example.com/",
            "domain": "example.com",
        }
        client = self.make_client()
        requests = self.add_responses(
            client,
            [
                (201, {"id": 7, "status": "pending"}),
                (200, {"id": 7, "status": "processing"}),
                (200, {"id": 7, "status": "completed", "result": [tab]}),
            ],
        )

        with patch("acob.client.asyncio.sleep", new_callable=AsyncMock) as sleep:
            result = await client.list()

        self.assertEqual(result, [ListedTab.model_validate(tab)])
        self.assertEqual(len(requests), 3)
        sleep.assert_awaited_once()

        submitted_request = requests[0]
        self.assertEqual(submitted_request.method, "POST")
        self.assertEqual(
            str(submitted_request.url),
            f"http://acob.test/api/browsers/{self.BID}/instructions/",
        )
        self.assertEqual(
            json.loads(submitted_request.content),
            {"action": "list"},
        )

        terminal_request = requests[2]
        self.assertEqual(terminal_request.method, "GET")
        self.assertEqual(
            str(terminal_request.url),
            f"http://acob.test/api/browsers/{self.BID}/instructions/7/",
        )

    async def test_submit_caps_the_http_request_timeout_at_60_seconds(self):
        client = ACOBClient(self.BID, endpoint="http://acob.test", timeout=90)
        self.addAsyncCleanup(client.aclose)
        request_json = AsyncMock(return_value={"id": 1, "status": "pending"})

        with patch.object(client, "_request_json", request_json):
            await client.submit("list")

        request_json.assert_awaited_once_with(
            "POST",
            f"http://acob.test/api/browsers/{self.BID}/instructions/",
            {"action": "list"},
            timeout=60,
        )

    async def test_action_methods_send_the_supported_api_payloads(self):
        client = self.make_client()
        tab = {
            "tid": 10,
            "window_id": 3,
            "active": True,
            "title": "Example",
            "url": "https://example.com/",
            "domain": "example.com",
        }
        execute = AsyncMock(
            side_effect=[
                [],
                tab,
                tab,
                tab,
                {"closed": True, "tab": tab},
                tab,
                {"scrolled": True, "y": 500.0},
                {
                    "clicked": True,
                    "selector": "button[type=submit]",
                    "x": 10.5,
                    "y": 20.5,
                },
                {"inserted_characters": 4},
                {"key": "Enter", "modifiers": ["ctrl", "shift"]},
                "Example",
            ]
        )

        with patch.object(client, "execute", execute):
            listed = await client.list()
            navigated = await client.navigate("https://example.com")
            navigated_existing = await client.navigate(
                "https://example.org",
                tid=10,
            )
            focused = await client.focus(10)
            closed = await client.close(10)
            reloaded = await client.reload(10)
            scrolled = await client.scroll(10, 500)
            clicked = await client.click(10, "button[type=submit]")
            inserted = await client.keyboard(10, text="ACOB")
            pressed = await client.keyboard(
                10,
                key="Enter",
                modifiers=["ctrl", "shift"],
            )
            title = await client.javascript(10, "document.title")

        self.assertEqual(listed, [])
        self.assertIsInstance(navigated, Tab)
        self.assertIsInstance(navigated_existing, Tab)
        self.assertIsInstance(focused, Tab)
        self.assertIsInstance(closed, ClosedTab)
        self.assertIsInstance(reloaded, Tab)
        self.assertIsInstance(scrolled, ScrollResult)
        self.assertIsInstance(clicked, ClickResult)
        self.assertIsInstance(inserted, KeyboardTextResult)
        self.assertIsInstance(pressed, KeyboardKeyResult)
        self.assertEqual(title, "Example")

        self.assertEqual(
            execute.call_args_list,
            [
                call("list", timeout=None),
                call(
                    "navigate",
                    timeout=None,
                    url="https://example.com",
                ),
                call(
                    "navigate",
                    timeout=None,
                    url="https://example.org",
                    tid=10,
                ),
                call("focus", tid=10, timeout=None),
                call("close", tid=10, timeout=None),
                call("reload", tid=10, timeout=None),
                call("scroll", tid=10, y=500, timeout=None),
                call(
                    "click",
                    tid=10,
                    selector="button[type=submit]",
                    timeout=None,
                ),
                call("keyboard", timeout=None, tid=10, text="ACOB"),
                call(
                    "keyboard",
                    timeout=None,
                    tid=10,
                    key="Enter",
                    modifiers=["ctrl", "shift"],
                ),
                call(
                    "javascript",
                    tid=10,
                    script="document.title",
                    timeout=None,
                ),
            ],
        )

    async def test_waits_for_independent_instructions_concurrently(self):
        client = self.make_client()
        started = set()
        both_started = asyncio.Event()

        async def request_json(_method, url, *, timeout):
            self.assertGreater(timeout, 0)
            instruction_id = int(url.rstrip("/").rsplit("/", 1)[-1])
            started.add(instruction_id)
            if len(started) == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), timeout=1)
            return {
                "id": instruction_id,
                "status": "completed",
                "result": instruction_id,
            }

        with patch.object(client, "_request_json", side_effect=request_json):
            first, second = await asyncio.gather(client.wait(1), client.wait(2))

        self.assertEqual(started, {1, 2})
        self.assertEqual(first["result"], 1)
        self.assertEqual(second["result"], 2)

    async def test_failed_instruction_raises_with_the_consumed_response(self):
        terminal = {
            "id": 4,
            "status": "failed",
            "result": None,
            "error": "No element matches selector: button",
        }
        client = self.make_client()
        self.add_responses(
            client,
            [
                (201, {"id": 4, "status": "pending"}),
                (200, terminal),
            ],
        )

        with self.assertRaises(ACOBInstructionError) as raised:
            await client.click(12, "button")

        self.assertEqual(raised.exception.instruction_id, 4)
        self.assertEqual(raised.exception.response, terminal)
        self.assertEqual(str(raised.exception), terminal["error"])

    async def test_http_validation_error_exposes_status_and_response(self):
        error_body = {
            "error": "Invalid request",
            "details": [
                {
                    "field": "javascript.script",
                    "message": "String should have at least 1 character",
                    "type": "string_too_short",
                }
            ],
        }
        client = self.make_client()
        self.add_responses(client, [(400, error_body)])

        with self.assertRaises(ACOBHTTPError) as raised:
            await client.javascript(12, "")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(raised.exception.response, error_body)
        self.assertIn("javascript.script", str(raised.exception))

    async def test_connection_error_uses_client_exception(self):
        client = self.make_client()
        client._http_client = httpx.AsyncClient(transport=FailingTransport())

        with self.assertRaisesRegex(ACOBConnectionError, "connection refused"):
            await client.submit("list")

    async def test_screenshot_returns_the_media_url_without_downloading(self):
        media_url = "https://chipf.test/api/files/638a5f9f16a24e1fbb4b3ab093016ec7"
        client = self.make_client()
        requests = self.add_responses(
            client,
            [
                (201, {"id": 8, "status": "pending"}),
                (
                    200,
                    {
                        "id": 8,
                        "status": "completed",
                        "result": {
                            "url": media_url,
                            "content_type": "image/png",
                            "full_page": True,
                        },
                    },
                ),
            ],
        )

        result = await client.screenshot(12, full_page=True)

        self.assertIsInstance(result, Screenshot)
        self.assertEqual(result.url, media_url)
        self.assertEqual(result.content_type, "image/png")
        self.assertTrue(result.full_page)
        self.assertEqual(result.tid, 12)
        self.assertFalse(hasattr(client, "download_screenshot"))
        self.assertEqual(len(requests), 2)
        self.assertEqual(
            json.loads(requests[0].content),
            {"action": "screenshot", "tid": 12, "full_page": True},
        )

    async def test_screenshot_rejects_an_invalid_media_url(self):
        client = self.make_client()
        execute = AsyncMock(
            return_value={
                "url": "file:///etc/passwd",
                "content_type": "image/png",
                "full_page": False,
            }
        )

        with (
            patch.object(client, "execute", execute),
            self.assertRaisesRegex(ACOBProtocolError, "invalid download URL"),
        ):
            await client.screenshot(12)

    async def test_record_start_returns_the_tracking_id(self):
        client = self.make_client()
        requests = self.add_responses(
            client,
            [
                (201, {"id": 9, "status": "pending"}),
                (
                    200,
                    {
                        "id": 9,
                        "status": "completed",
                        "result": {"recording_id": 9, "started": True},
                    },
                ),
            ],
        )

        result = await client.record_start(12)

        self.assertIsInstance(result, RecordingStart)
        self.assertEqual(result.recording_id, 9)
        self.assertTrue(result.started)
        self.assertEqual(result.tid, 12)
        self.assertEqual(len(requests), 2)
        self.assertEqual(
            json.loads(requests[0].content),
            {"action": "record_start", "tid": 12, "full_page": False},
        )

    async def test_record_start_sends_the_full_page_flag(self):
        client = self.make_client()
        requests = self.add_responses(
            client,
            [
                (201, {"id": 9, "status": "pending"}),
                (
                    200,
                    {
                        "id": 9,
                        "status": "completed",
                        "result": {"recording_id": 9, "started": True},
                    },
                ),
            ],
        )

        result = await client.record_start(12, full_page=True)

        self.assertIsInstance(result, RecordingStart)
        self.assertEqual(
            json.loads(requests[0].content),
            {"action": "record_start", "tid": 12, "full_page": True},
        )

    async def test_record_stop_returns_the_media_url(self):
        media_url = "https://chipf.test/api/files/638a5f9f16a24e1fbb4b3ab093016ec7"
        client = self.make_client()
        requests = self.add_responses(
            client,
            [
                (201, {"id": 10, "status": "pending"}),
                (
                    200,
                    {
                        "id": 10,
                        "status": "completed",
                        "result": {
                            "url": media_url,
                            "content_type": "video/webm",
                            "duration": 300.0,
                            "stopped_reason": "max_duration",
                            "message": (
                                "Recording stopped because the maximum "
                                "duration was reached"
                            ),
                        },
                    },
                ),
            ],
        )

        result = await client.record_stop(9)

        self.assertIsInstance(result, RecordingStop)
        self.assertEqual(result.url, media_url)
        self.assertEqual(result.content_type, "video/webm")
        self.assertEqual(result.duration, 300.0)
        self.assertEqual(result.stopped_reason, "max_duration")
        self.assertIn("maximum duration", result.message)
        self.assertEqual(result.recording_id, 9)
        self.assertEqual(len(requests), 2)
        self.assertEqual(
            json.loads(requests[0].content),
            {"action": "record_stop", "recording_id": 9},
        )

    async def test_record_stop_accepts_an_mp4_recording(self):
        media_url = "https://chipf.test/api/files/638a5f9f16a24e1fbb4b3ab093016ec7"
        client = self.make_client()
        requests = self.add_responses(
            client,
            [
                (201, {"id": 11, "status": "pending"}),
                (
                    200,
                    {
                        "id": 11,
                        "status": "completed",
                        "result": {
                            "url": media_url,
                            "content_type": "video/mp4",
                            "duration": 12.0,
                            "stopped_reason": "user",
                            "message": "Recording stopped by user request",
                        },
                    },
                ),
            ],
        )

        result = await client.record_stop(11)

        self.assertIsInstance(result, RecordingStop)
        self.assertEqual(result.content_type, "video/mp4")
        self.assertEqual(result.duration, 12.0)
        self.assertEqual(len(requests), 2)

    async def test_record_stop_rejects_invalid_recording_id(self):
        client = self.make_client()
        invalid_ids: list[object] = [0, -1, True, "9"]

        for invalid in invalid_ids:
            with self.subTest(recording_id=invalid), self.assertRaises(ValueError):
                await client.record_stop(invalid)  # type: ignore[arg-type]

    async def test_record_stop_rejects_an_invalid_media_url(self):
        client = self.make_client()
        execute = AsyncMock(
            return_value={
                "url": "file:///etc/passwd",
                "content_type": "video/webm",
                "duration": 5.0,
                "stopped_reason": "user",
                "message": "Recording stopped by user request",
            }
        )

        with (
            patch.object(client, "execute", execute),
            self.assertRaisesRegex(ACOBProtocolError, "invalid download URL"),
        ):
            await client.record_stop(9)

    async def test_settings_returns_the_reported_browser_settings(self):
        client = self.make_client()
        reported = {
            "settings": {
                "pollIntervalMs": 1000,
                "maxRecordingDurationMs": 300000,
                "maxRecordingSizeMiB": 60,
            },
            "updated_at": "2026-08-12T00:00:00Z",
        }
        requests = self.add_responses(client, [(200, reported)])

        result = await client.settings()

        self.assertIsInstance(result, BrowserSettings)
        self.assertEqual(result.settings["maxRecordingDurationMs"], 300000)
        self.assertEqual(result.updated_at, "2026-08-12T00:00:00Z")
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].method, "GET")
        self.assertIn("/settings/", str(requests[0].url))

    async def test_settings_surfaces_an_unreported_browser(self):
        client = self.make_client()
        self.add_responses(
            client,
            [
                (
                    404,
                    {
                        "error": (
                            "Browser settings not found; the extension has "
                            "not reported yet"
                        )
                    },
                )
            ],
        )

        with self.assertRaises(ACOBHTTPError) as raised:
            await client.settings()

        self.assertEqual(raised.exception.status_code, 404)

    async def test_action_methods_reject_malformed_browser_results(self):
        client = self.make_client()

        with (
            patch.object(
                client,
                "execute",
                AsyncMock(return_value=[{"tid": "12"}]),
            ),
            self.assertRaisesRegex(
                ACOBProtocolError,
                "list returned an invalid result",
            ),
        ):
            await client.list()

        with (
            patch.object(
                client,
                "execute",
                AsyncMock(return_value={"scrolled": True, "y": float("inf")}),
            ),
            self.assertRaisesRegex(
                ACOBProtocolError,
                "scroll returned an invalid result",
            ),
        ):
            await client.scroll(12, 500)

    async def test_javascript_returns_the_value_unchanged(self):
        client = self.make_client()
        value = object()

        with patch.object(client, "execute", AsyncMock(return_value=value)):
            result = await client.javascript(12, "window.value")

        self.assertIs(result, value)

    async def test_reinstall_uses_the_out_of_band_recovery_endpoint(self):
        client = self.make_client()
        requests = self.add_responses(
            client,
            [
                (
                    202,
                    {
                        "token": "01234567-89ab-4def-8123-456789abcdef",
                        "status": "pending",
                        "requested_at": "2026-08-01T12:00:00Z",
                    },
                )
            ],
        )

        result = await client.reinstall()

        self.assertIsInstance(result, ReinstallResult)
        self.assertEqual(result.status, "pending")
        self.assertEqual(requests[0].method, "POST")
        self.assertEqual(
            str(requests[0].url),
            f"http://acob.test/api/browsers/{self.BID}/reinstall/",
        )

    async def test_timeout_retains_instruction_id_for_later_recovery(self):
        client = self.make_client()
        request_json = AsyncMock(return_value={"id": 21, "status": "pending"})

        with (
            patch("acob.client.asyncio.get_running_loop") as get_loop,
            patch.object(client, "_request_json", request_json),
        ):
            get_loop.return_value.time.side_effect = [0, 0, 1]
            with self.assertRaises(ACOBTimeoutError) as raised:
                await client.wait(21, timeout=1)

        self.assertEqual(raised.exception.instruction_id, 21)
        self.assertEqual(raised.exception.timeout, 1)

    async def test_wait_rejects_a_malformed_status_as_a_protocol_error(self):
        client = self.make_client()

        with patch.object(
            client,
            "_request_json",
            AsyncMock(return_value={"id": 21, "status": []}),
        ):
            with self.assertRaisesRegex(ACOBProtocolError, "invalid response"):
                await client.wait(21)

    async def test_cancelled_close_can_be_awaited_again(self):
        client = self.make_client()
        http_client = AsyncMock(spec=httpx.AsyncClient)
        client._http_client = http_client
        close_started = asyncio.Event()
        release_close = asyncio.Event()

        async def slow_close():
            close_started.set()
            await release_close.wait()

        http_client.aclose.side_effect = slow_close
        first_close = asyncio.create_task(client.aclose())
        await close_started.wait()
        first_close.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first_close

        second_close = asyncio.create_task(client.aclose())
        await asyncio.sleep(0)
        self.assertFalse(second_close.done())
        release_close.set()
        await second_close

        http_client.aclose.assert_awaited_once()

    async def test_closed_client_rejects_new_requests(self):
        client = self.make_client()

        await client.aclose()

        with self.assertRaisesRegex(ACOBError, "ACOBClient is closed"):
            await client.submit("list")


if __name__ == "__main__":
    unittest.main()
