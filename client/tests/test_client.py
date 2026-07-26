import json
import unittest
from email.message import Message
from io import BytesIO
from typing import TYPE_CHECKING
from unittest.mock import call, patch
from urllib.error import HTTPError
from urllib.request import Request

from acob import (
    DEFAULT_ENDPOINT,
    ACOBClient,
    ACOBHTTPError,
    ACOBInstructionError,
    ACOBProtocolError,
    ACOBTimeoutError,
    ClickResult,
    ClosedTab,
    KeyboardKeyResult,
    KeyboardTextResult,
    ListedTab,
    Tab,
)

if TYPE_CHECKING:

    def _check_return_types(client: ACOBClient) -> None:
        _listed: list[ListedTab] = client.tabs(operation="list")
        _navigated: Tab = client.tabs(
            operation="navigate",
            url="https://example.com",
        )
        _focused: Tab = client.tabs(operation="focus", tid=1)
        _closed: ClosedTab = client.tabs(operation="close", tid=1)
        _clicked: ClickResult = client.click(1, "button")
        _inserted: KeyboardTextResult = client.keyboard(1, text="ACOB")
        _pressed: KeyboardKeyResult = client.keyboard(1, key="Enter")
        _screenshot: bytes = client.screenshot(1)
        _javascript: int = client.javascript(1, "1")


class FakeResponse:
    def __init__(self, body):
        self.body = (
            body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        )

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback):
        return False

    def read(self):
        return self.body


class ACOBClientTests(unittest.TestCase):
    BID = "0123456789ab4def8123456789abcdef"

    def make_client(self, endpoint="http://acob.test/"):
        return ACOBClient(
            self.BID,
            endpoint=endpoint,
            timeout=5,
            poll_interval=0.01,
        )

    def test_initializes_with_default_endpoint_and_validates_configuration(self):
        client = ACOBClient(self.BID)

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

    def test_tabs_submits_and_consumes_terminal_response(self):
        tab = {
            "tid": 12,
            "window_id": 3,
            "active": True,
            "focused": True,
            "title": "Example",
            "url": "https://example.com/",
            "domain": "example.com",
        }
        responses = [
            FakeResponse({"id": 7, "status": "pending"}),
            FakeResponse({"id": 7, "status": "processing"}),
            FakeResponse({"id": 7, "status": "completed", "result": [tab]}),
        ]

        with (
            patch("acob.client.urlopen", side_effect=responses) as mocked_urlopen,
            patch("acob.client.time.sleep") as mocked_sleep,
        ):
            result = self.make_client().tabs(operation="list")

        self.assertEqual(result, [ListedTab.model_validate(tab)])
        self.assertEqual(mocked_urlopen.call_count, 3)
        self.assertEqual(mocked_sleep.call_count, 1)

        submitted_request = mocked_urlopen.call_args_list[0].args[0]
        self.assertIsInstance(submitted_request, Request)
        self.assertEqual(submitted_request.get_method(), "POST")
        self.assertEqual(
            submitted_request.full_url,
            f"http://acob.test/api/browsers/{self.BID}/instructions/",
        )
        self.assertEqual(
            json.loads(submitted_request.data),
            {"action": "tabs", "operation": "list"},
        )

        terminal_request = mocked_urlopen.call_args_list[2].args[0]
        self.assertEqual(terminal_request.get_method(), "GET")
        self.assertEqual(
            terminal_request.full_url,
            f"http://acob.test/api/browsers/{self.BID}/instructions/7/",
        )

    def test_action_methods_send_the_supported_api_payloads(self):
        client = self.make_client()
        tab = {
            "tid": 10,
            "window_id": 3,
            "active": True,
            "title": "Example",
            "url": "https://example.com/",
            "domain": "example.com",
        }

        with patch.object(
            client,
            "execute",
            side_effect=[
                [],
                tab,
                tab,
                tab,
                {"closed": True, "tab": tab},
                {
                    "clicked": True,
                    "selector": "button[type=submit]",
                    "x": 10.5,
                    "y": 20.5,
                },
                {"inserted_characters": 4},
                {"key": "Enter", "modifiers": ["ctrl", "shift"]},
                "Example",
            ],
        ) as execute:
            listed = client.tabs(operation="list")
            navigated = client.tabs(operation="navigate", url="https://example.com")
            navigated_existing = client.tabs(
                operation="navigate",
                tid=10,
                url="https://example.org",
            )
            focused = client.tabs(operation="focus", tid=10)
            closed = client.tabs(operation="close", tid=10)
            clicked = client.click(10, "button[type=submit]")
            inserted = client.keyboard(10, text="ACOB")
            pressed = client.keyboard(10, key="Enter", modifiers=["ctrl", "shift"])
            title = client.javascript(10, "document.title")

        self.assertEqual(listed, [])
        self.assertIsInstance(navigated, Tab)
        self.assertIsInstance(navigated_existing, Tab)
        self.assertIsInstance(focused, Tab)
        self.assertIsInstance(closed, ClosedTab)
        self.assertIsInstance(clicked, ClickResult)
        self.assertIsInstance(inserted, KeyboardTextResult)
        self.assertIsInstance(pressed, KeyboardKeyResult)
        self.assertEqual(title, "Example")

        self.assertEqual(
            execute.call_args_list,
            [
                call("tabs", timeout=None, operation="list"),
                call(
                    "tabs",
                    timeout=None,
                    operation="navigate",
                    url="https://example.com",
                ),
                call(
                    "tabs",
                    timeout=None,
                    operation="navigate",
                    tid=10,
                    url="https://example.org",
                ),
                call("tabs", timeout=None, operation="focus", tid=10),
                call("tabs", timeout=None, operation="close", tid=10),
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

    def test_failed_instruction_raises_with_the_consumed_response(self):
        terminal = {
            "id": 4,
            "status": "failed",
            "result": None,
            "error": "No element matches selector: button",
        }
        with patch(
            "acob.client.urlopen",
            side_effect=[
                FakeResponse({"id": 4, "status": "pending"}),
                FakeResponse(terminal),
            ],
        ):
            with self.assertRaises(ACOBInstructionError) as raised:
                self.make_client().click(12, "button")

        self.assertEqual(raised.exception.instruction_id, 4)
        self.assertEqual(raised.exception.response, terminal)
        self.assertEqual(str(raised.exception), terminal["error"])

    def test_http_validation_error_exposes_status_and_response(self):
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
        http_error = HTTPError(
            "http://acob.test/instructions/",
            400,
            "Bad Request",
            Message(),
            BytesIO(json.dumps(error_body).encode("utf-8")),
        )

        with patch("acob.client.urlopen", side_effect=http_error):
            with self.assertRaises(ACOBHTTPError) as raised:
                self.make_client().javascript(12, "")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(raised.exception.response, error_body)
        self.assertIn("javascript.script", str(raised.exception))

    def test_screenshot_returns_bytes_and_consumes_its_download(self):
        image = b"\x89PNG\r\n\x1a\nACOB"
        download_url = f"/api/browsers/{self.BID}/screenshots/9/"
        responses = [
            FakeResponse({"id": 8, "status": "pending"}),
            FakeResponse(
                {
                    "id": 8,
                    "status": "completed",
                    "result": {
                        "download_url": download_url,
                        "content_type": "image/png",
                        "full_page": True,
                        "single_use": True,
                        "tid": 12,
                    },
                }
            ),
            FakeResponse(image),
        ]

        with patch(
            "acob.client.urlopen",
            side_effect=responses,
        ) as mocked_urlopen:
            client = self.make_client()
            result = client.screenshot(12, full_page=True)

        self.assertEqual(result, image)
        self.assertFalse(hasattr(client, "download_screenshot"))
        submitted_request = mocked_urlopen.call_args_list[0].args[0]
        self.assertEqual(
            json.loads(submitted_request.data),
            {"action": "screenshot", "tid": 12, "full_page": True},
        )
        download_request = mocked_urlopen.call_args_list[2].args[0]
        self.assertEqual(download_request.full_url, f"http://acob.test{download_url}")
        self.assertEqual(download_request.get_method(), "GET")

    def test_screenshot_rejects_a_download_on_another_origin(self):
        client = self.make_client()
        with (
            patch.object(
                client,
                "execute",
                return_value={
                    "download_url": "https://example.com/image.png",
                    "content_type": "image/png",
                    "full_page": False,
                    "single_use": True,
                    "tid": 12,
                },
            ),
            self.assertRaises(ACOBProtocolError),
        ):
            client.screenshot(12)

    def test_action_methods_reject_malformed_browser_results(self):
        client = self.make_client()

        with (
            patch.object(client, "execute", return_value=[{"tid": "12"}]),
            self.assertRaisesRegex(
                ACOBProtocolError,
                "tabs returned an invalid result",
            ),
        ):
            client.tabs(operation="list")

    def test_javascript_returns_the_value_unchanged(self):
        client = self.make_client()
        value = object()

        with patch.object(client, "execute", return_value=value):
            result = client.javascript(12, "window.value")

        self.assertIs(result, value)

    def test_timeout_retains_instruction_id_for_later_recovery(self):
        with (
            patch(
                "acob.client.urlopen",
                return_value=FakeResponse({"id": 21, "status": "pending"}),
            ),
            patch("acob.client.time.monotonic", side_effect=[0, 0, 1]),
        ):
            with self.assertRaises(ACOBTimeoutError) as raised:
                self.make_client().wait(21, timeout=1)

        self.assertEqual(raised.exception.instruction_id, 21)
        self.assertEqual(raised.exception.timeout, 1)


if __name__ == "__main__":
    unittest.main()
