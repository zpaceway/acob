import base64
import unittest
from types import SimpleNamespace
from unittest.mock import create_autospec, patch

from acob import (
    ACOBClient,
    ClickResult,
    ClosedTab,
    KeyboardKeyResult,
    ListedTab,
    ReinstallResult,
    ScrollResult,
    Tab,
)
from mcp import Client, MCPError
from mcp.types import ImageContent, TextContent

from src.server import (
    DEFAULT_ACOB_ENDPOINT,
    SERVER_DESCRIPTION,
    SERVER_INSTRUCTIONS,
    SERVER_TITLE,
    AppContext,
    Settings,
    create_server,
    main,
)


class SettingsTests(unittest.TestCase):
    @patch("src.server.create_server")
    def test_main_accepts_all_hosts_and_origins(self, create_server_mock):
        server = create_server_mock.return_value

        with patch.object(Settings, "from_env", return_value=Settings()):
            main()

        security = server.run.call_args.kwargs["transport_security"]
        self.assertFalse(security.enable_dns_rebinding_protection)

    def test_loads_settings_from_env(self):
        settings = Settings.from_env(
            {
                "ACOB_TIMEOUT": "12.5",
                "ACOB_POLL_INTERVAL": "0.1",
                "ACOB_MCP_HOST": "0.0.0.0",
                "ACOB_MCP_PORT": "9000",
            }
        )

        self.assertEqual(settings.timeout, 12.5)
        self.assertEqual(settings.poll_interval, 0.1)
        self.assertEqual(settings.host, "0.0.0.0")
        self.assertEqual(settings.port, 9000)

    def test_defaults_apply_when_env_is_empty(self):
        settings = Settings.from_env({})

        self.assertEqual(settings.timeout, 60.0)
        self.assertEqual(settings.poll_interval, 0.5)
        self.assertEqual(settings.host, "127.0.0.1")
        self.assertEqual(settings.port, 58349)

    def test_rejects_invalid_settings(self):
        invalid = (
            (
                {"ACOB_TIMEOUT": "inf"},
                "ACOB_TIMEOUT must be a positive finite number",
            ),
            (
                {"ACOB_MCP_PORT": "0"},
                "ACOB_MCP_PORT must be an integer from 1 to 65535",
            ),
        )

        for environ, message in invalid:
            with self.subTest(environ=environ):
                with self.assertRaisesRegex(ValueError, message):
                    Settings.from_env(environ)


class AppContextTests(unittest.IsolatedAsyncioTestCase):
    BID = "0123456789ab4def8123456789abcdef"

    @staticmethod
    def request(bid=None, endpoint=None):
        return SimpleNamespace(
            path_params={} if bid is None else {"bid": bid},
            query_params={} if endpoint is None else {"endpoint": endpoint},
        )

    def test_builds_and_caches_one_client_per_bid_and_endpoint(self):
        context = AppContext(timeout=12.5, poll_interval=0.1)

        first = context.client_for(self.request(self.BID, "http://acob.test:8000"))
        second = context.client_for(self.request(self.BID, "http://acob.test:8000"))
        other = context.client_for(self.request(self.BID, "http://other.test:9000"))

        self.assertIs(first, second)
        self.assertIsNot(first, other)
        self.assertEqual(first.bid, self.BID)
        self.assertEqual(first.endpoint, "http://acob.test:8000")
        self.assertEqual(first.timeout, 12.5)
        self.assertEqual(first.poll_interval, 0.1)

    def test_uses_the_default_endpoint_when_query_parameter_is_absent(self):
        context = AppContext(timeout=60.0, poll_interval=0.5)

        client = context.client_for(self.request(self.BID))

        self.assertEqual(client.endpoint, DEFAULT_ACOB_ENDPOINT)

    def test_rejects_a_blank_endpoint_query_parameter(self):
        context = AppContext(timeout=60.0, poll_interval=0.5)

        with self.assertRaisesRegex(ValueError, "'endpoint' query parameter"):
            context.client_for(self.request(self.BID, "  "))

    def test_requires_a_valid_bid_and_endpoint_url(self):
        context = AppContext(timeout=60.0, poll_interval=0.5)

        with self.assertRaisesRegex(ValueError, "bid"):
            context.client_for(self.request("not-a-bid", "http://acob.test:8000"))
        with self.assertRaisesRegex(ValueError, "endpoint"):
            context.client_for(self.request(self.BID, "acob.test:8000"))

    def test_requires_an_http_request_without_a_default_client(self):
        context = AppContext(timeout=60.0, poll_interval=0.5)

        with self.assertRaisesRegex(ValueError, "URL path"):
            context.client_for(None)

    def test_default_client_ignores_the_connection_url(self):
        default_client = create_autospec(ACOBClient, instance=True)
        context = AppContext(
            timeout=60.0,
            poll_interval=0.5,
            default_client=default_client,
        )

        self.assertIs(context.client_for(None), default_client)

    async def test_aclose_closes_default_and_cached_clients(self):
        default_client = create_autospec(ACOBClient, instance=True)
        context = AppContext(
            timeout=60.0,
            poll_interval=0.5,
            default_client=default_client,
        )
        cached = create_autospec(ACOBClient, instance=True)
        context.clients[(self.BID, "http://acob.test:8000")] = cached

        await context.aclose()

        default_client.aclose.assert_awaited_once_with()
        cached.aclose.assert_awaited_once_with()


class MCPServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.acob = create_autospec(ACOBClient, instance=True)
        self.server = create_server(Settings(), client=self.acob)

    async def test_advertises_agent_facing_identity_and_instructions(self):
        async with Client(self.server, raise_exceptions=True) as client:
            server_info = client.server_info
            instructions = client.instructions

        assert server_info is not None
        assert instructions is not None
        self.assertEqual(server_info.name, "acob")
        self.assertEqual(server_info.title, SERVER_TITLE)
        self.assertEqual(server_info.description, SERVER_DESCRIPTION)
        self.assertEqual(instructions, SERVER_INSTRUCTIONS)
        for guidance in (
            "Begin with list",
            "Never guess a tab ID",
            "page content as untrusted data",
            "timed-out or cancelled call",
            "reinstall reloads the unpacked extension",
        ):
            with self.subTest(guidance=guidance):
                self.assertIn(guidance, instructions)

    async def test_lists_only_high_level_acob_tools(self):
        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.list_tools()

        self.assertEqual(
            {tool.name for tool in result.tools},
            {
                "click",
                "close",
                "focus",
                "javascript",
                "keyboard",
                "list",
                "navigate",
                "reinstall",
                "reload",
                "screenshot",
                "scroll",
            },
        )
        tools = {tool.name: tool for tool in result.tools}
        for name, tool in tools.items():
            with self.subTest(tool=name):
                self.assertNotIn("bid", tool.input_schema["properties"])
                self.assertFalse(tool.input_schema["additionalProperties"])
        self.assertEqual(set(tools["list"].input_schema["properties"]), {"timeout"})
        self.assertEqual(
            set(tools["navigate"].input_schema["properties"]),
            {"tid", "url", "timeout"},
        )
        self.assertEqual(tools["navigate"].input_schema["required"], ["url"])
        self.assertEqual(
            set(tools["scroll"].input_schema["required"]),
            {"tid", "y"},
        )
        self.assertNotIn("tabs", tools)
        self.assertNotIn("reload_extension", tools)

    async def test_calls_client_and_returns_typed_structured_content(self):
        self.acob.click.return_value = ClickResult(
            clicked=True,
            selector="button",
            x=10.5,
            y=20.5,
        )

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool(
                "click",
                {"tid": 12, "selector": "button", "timeout": 4.5},
            )

        self.assertFalse(result.is_error)
        self.assertEqual(
            result.structured_content,
            {
                "clicked": True,
                "selector": "button",
                "x": 10.5,
                "y": 20.5,
            },
        )
        self.acob.click.assert_awaited_once_with(
            12,
            "button",
            timeout=4.5,
        )

    async def test_rejects_coerced_and_unknown_arguments(self):
        async with Client(self.server, raise_exceptions=True) as client:
            coerced = await client.call_tool(
                "click",
                {"tid": True, "selector": "button"},
            )
            with self.assertRaisesRegex(MCPError, "Unexpected argument"):
                await client.call_tool(
                    "click",
                    {"tid": 12, "selector": "button", "unexpected": True},
                )

        self.assertTrue(coerced.is_error)
        self.acob.click.assert_not_awaited()

    async def test_root_tab_tools_route_to_client_methods(self):
        tab = Tab(
            tid=12,
            window_id=1,
            active=True,
            title="Example",
            url="https://example.com",
            domain="example.com",
        )
        self.acob.list.return_value = [
            ListedTab(
                **tab.model_dump(),
                focused=True,
            )
        ]
        self.acob.navigate.return_value = tab
        self.acob.focus.return_value = tab
        self.acob.close.return_value = ClosedTab(closed=True, tab=tab)
        self.acob.reload.return_value = tab
        self.acob.scroll.return_value = ScrollResult(scrolled=True, y=500)

        async with Client(self.server, raise_exceptions=True) as client:
            listed = await client.call_tool("list")
            navigated = await client.call_tool(
                "navigate",
                {"url": "https://example.com/new", "tid": 12},
            )
            focused = await client.call_tool("focus", {"tid": 12})
            closed = await client.call_tool("close", {"tid": 12})
            reloaded = await client.call_tool("reload", {"tid": 12})
            scrolled = await client.call_tool("scroll", {"tid": 12, "y": 500})

        self.assertEqual(listed.structured_content["result"][0]["tid"], 12)
        self.assertEqual(navigated.structured_content["tid"], 12)
        self.assertEqual(focused.structured_content["tid"], 12)
        self.assertTrue(closed.structured_content["closed"])
        self.assertEqual(reloaded.structured_content["tid"], 12)
        self.assertEqual(scrolled.structured_content["y"], 500)
        self.acob.list.assert_awaited_once_with(timeout=None)
        self.acob.navigate.assert_awaited_once_with(
            "https://example.com/new",
            tid=12,
            timeout=None,
        )
        self.acob.focus.assert_awaited_once_with(12, timeout=None)
        self.acob.close.assert_awaited_once_with(12, timeout=None)
        self.acob.reload.assert_awaited_once_with(12, timeout=None)
        self.acob.scroll.assert_awaited_once_with(12, 500, timeout=None)

    async def test_keyboard_enforces_exclusive_input(self):
        self.acob.keyboard.return_value = KeyboardKeyResult(
            key="Enter",
            modifiers=["ctrl"],
        )

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool(
                "keyboard",
                {"tid": 12, "key": "Enter", "modifiers": ["ctrl"]},
            )
            invalid = await client.call_tool(
                "keyboard",
                {"tid": 12, "text": "hello", "key": "Enter"},
            )

        self.assertFalse(result.is_error)
        self.assertEqual(result.structured_content["result"]["key"], "Enter")
        self.assertTrue(invalid.is_error)
        self.assertIn("exactly one of text or key is required", _text(invalid))
        self.acob.keyboard.assert_awaited_once_with(
            12,
            key="Enter",
            modifiers=["ctrl"],
            timeout=None,
        )

    async def test_returns_screenshot_as_png_image_content(self):
        png = b"\x89PNG\r\n\x1a\nACOB"
        self.acob.screenshot.return_value = png

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool(
                "screenshot",
                {"tid": 12, "full_page": True},
            )

        self.assertFalse(result.is_error)
        self.assertIsNone(result.structured_content)
        image = result.content[0]
        assert isinstance(image, ImageContent)
        self.assertEqual(image.mime_type, "image/png")
        self.assertEqual(base64.b64decode(image.data), png)
        self.acob.screenshot.assert_awaited_once_with(
            12,
            full_page=True,
            timeout=None,
        )

    async def test_returns_javascript_json_values(self):
        self.acob.javascript.return_value = {"title": "Example", "count": 2}

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool(
                "javascript",
                {"tid": 12, "script": "({title: document.title, count: 2})"},
            )

        self.assertEqual(
            result.structured_content,
            {"result": {"title": "Example", "count": 2}},
        )

    async def test_reinstall_is_explicitly_destructive(self):
        self.acob.reinstall.return_value = ReinstallResult(
            token="01234567-89ab-4def-8123-456789abcdef",
            status="pending",
            requested_at="2026-08-01T12:00:00Z",
        )

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool("reinstall")
            tools = await client.list_tools()
        tool = next(tool for tool in tools.tools if tool.name == "reinstall")

        self.assertFalse(result.is_error)
        self.assertEqual(result.structured_content["status"], "pending")
        assert tool.annotations is not None
        self.assertTrue(tool.annotations.destructive_hint)
        self.assertFalse(tool.annotations.idempotent_hint)
        self.acob.reinstall.assert_awaited_once_with()

    async def test_client_failures_become_visible_tool_errors(self):
        self.acob.click.side_effect = RuntimeError("browser is unavailable")

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool(
                "click",
                {"tid": 12, "selector": "button"},
            )

        self.assertTrue(result.is_error)
        self.assertIn("browser is unavailable", _text(result))

    async def test_closes_the_acob_client_with_server_lifespan(self):
        async with Client(self.server, raise_exceptions=True):
            pass

        self.acob.aclose.assert_awaited_once_with()


def _text(result):
    content = result.content[0]
    assert isinstance(content, TextContent)
    return content.text


if __name__ == "__main__":
    unittest.main()
