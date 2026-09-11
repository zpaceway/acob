import unittest
from dataclasses import replace
from unittest.mock import Mock, create_autospec, patch

from acob import (
    ACOBClient,
    ApiDocumentation,
    BatchResultEntry,
    CleanupResult,
    ClickResult,
    ClosedTab,
    ConsoleCapture,
    ConsoleStarted,
    KeyboardKeyResult,
    KeyboardTextResult,
    ListedTab,
    ProxySet,
    ProxyUnset,
    RecordingStart,
    RecordingStop,
    ReinstallResult,
    Screenshot,
    ScrollResult,
    Tab,
)
from mcp import Client, MCPError
from mcp.server.context import CallNext, HandlerResult, ServerRequestContext
from mcp.types import CallToolResult, TextContent
from starlette.requests import Request
from typing_extensions import override

from src.server import (
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
    def test_main_accepts_all_hosts_and_origins(
        self,
        create_server_mock: Mock,
    ) -> None:
        server = create_server_mock.return_value

        with patch.object(Settings, "from_env", return_value=Settings()):
            main()

        security = server.run.call_args.kwargs["transport_security"]
        self.assertFalse(security.enable_dns_rebinding_protection)
        self.assertEqual(server.run.call_args.kwargs["streamable_http_path"], "/mcp")

    def test_loads_settings_from_env(self) -> None:
        settings = Settings.from_env(
            {
                "ACOB_MCP_TIMEOUT": "12.5",
                "ACOB_MCP_POLL_INTERVAL": "0.1",
                "ACOB_MCP_HOST": "0.0.0.0",
                "ACOB_MCP_PORT": "9000",
                "ACOB_MCP_ENDPOINT": "http://acob.example:58347",
            }
        )

        self.assertEqual(settings.timeout, 12.5)
        self.assertEqual(settings.poll_interval, 0.1)
        self.assertEqual(settings.host, "0.0.0.0")
        self.assertEqual(settings.port, 9000)
        self.assertEqual(settings.endpoint, "http://acob.example:58347")

    def test_requires_the_endpoint_configuration(self) -> None:
        invalid = (
            ({}, "ACOB_MCP_ENDPOINT must be set to a valid HTTP or HTTPS URL"),
            (
                {"ACOB_MCP_ENDPOINT": "  "},
                "ACOB_MCP_ENDPOINT must be set to a valid HTTP or HTTPS URL",
            ),
        )

        for environ, message in invalid:
            with (
                self.subTest(environ=environ),
                self.assertRaisesRegex(ValueError, message),
            ):
                Settings.from_env(environ)

    def test_rejects_invalid_settings(self) -> None:
        base = {"ACOB_MCP_ENDPOINT": "http://acob.example:58347"}
        invalid = (
            (
                {**base, "ACOB_MCP_TIMEOUT": "inf"},
                "ACOB_MCP_TIMEOUT must be a positive finite number",
            ),
            (
                {**base, "ACOB_MCP_PORT": "0"},
                "ACOB_MCP_PORT must be an integer from 1 to 65535",
            ),
            (
                {**base, "ACOB_MCP_ENDPOINT": "not-a-url"},
                "ACOB_MCP_ENDPOINT must be a valid HTTP or HTTPS URL",
            ),
            (
                {**base, "ACOB_MCP_ENDPOINT": "http://acob.example?q=1"},
                "ACOB_MCP_ENDPOINT must be a valid HTTP or HTTPS URL",
            ),
        )

        for environ, message in invalid:
            with (
                self.subTest(environ=environ),
                self.assertRaisesRegex(ValueError, message),
            ):
                Settings.from_env(environ)


class AppContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_aclose_closes_the_installation_client(self) -> None:
        client = create_autospec(ACOBClient, instance=True)
        context = AppContext(client=client)

        await context.aclose()

        client.aclose.assert_awaited_once_with()


class MCPServerTests(unittest.IsolatedAsyncioTestCase):
    async def test_api_links_follow_request_only_in_same_origin_mode(self) -> None:
        docs = ApiDocumentation(
            base_url="http://api.test:58347",
            swagger_url="http://api.test:58347/api/docs/",
            openapi_url="http://api.test:58347/api/openapi.json",
            instructions_url="http://api.test:58347/api/instructions/",
            instruction_url_template="http://api.test:58347/api/instructions/{instruction_id}/",
            batch_url="http://api.test:58347/api/instructions/batch/",
            guide=["Save the terminal response; it is consumed."],
        )
        self.acob.api.return_value = docs
        for same_origin in (False, True):
            for host in ("localhost:61554", "[::1]:61555"):

                async def request_context(
                    ctx: ServerRequestContext[AppContext, object],
                    call_next: CallNext,
                    host: str = host,
                ) -> HandlerResult:
                    request = Request(
                        {
                            "type": "http",
                            "scheme": "https",
                            "path": "/mcp",
                            "root_path": "",
                            "headers": [(b"host", host.encode())],
                        }
                    )
                    return await call_next(replace(ctx, request=request))

                server = create_server(
                    Settings(api_same_origin=same_origin), client=self.acob
                )
                server.middleware.insert(0, request_context)
                async with Client(server, raise_exceptions=True) as client:
                    result = await client.call_tool("api", {})
                    tools = {t.name: t for t in (await client.list_tools()).tools}
                content = result.structured_content
                assert content is not None
                origin = f"https://{host}" if same_origin else docs.base_url
                self.assertEqual(content["base_url"], origin)
                self.assertEqual(content["swagger_url"], origin + "/api/docs/")
                self.assertEqual(content["guide"], docs.guide)
                self.assertEqual(tools["api"].input_schema.get("properties", {}), {})
                assert tools["api"].annotations is not None
                self.assertTrue(tools["api"].annotations.read_only_hint)
        self.acob.submit.assert_not_called()

    @override
    async def asyncSetUp(self) -> None:
        self.acob = create_autospec(ACOBClient, instance=True)
        self.server = create_server(Settings(), client=self.acob)

    async def test_advertises_agent_facing_identity_and_instructions(self) -> None:
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
            "ACOB_MCP_ENDPOINT environment variable",
            "served by the ACOB server",
            "execute_batch",
        ):
            with self.subTest(guidance=guidance):
                self.assertIn(guidance, instructions)

    async def test_lists_only_high_level_acob_tools(self) -> None:
        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.list_tools()

        self.assertEqual(
            {tool.name for tool in result.tools},
            {
                "api",
                "cleanup",
                "click",
                "close",
                "console",
                "execute_batch",
                "focus",
                "javascript",
                "keyboard",
                "list",
                "navigate",
                "proxy",
                "record",
                "reinstall",
                "reload",
                "screenshot",
                "scroll",
            },
        )
        tools = {tool.name: tool for tool in result.tools}
        for name, tool in tools.items():
            with self.subTest(tool=name):
                self.assertFalse(tool.input_schema["additionalProperties"])
        self.assertEqual(
            set(tools["list"].input_schema["properties"]), {"timeout", "bid"}
        )
        self.assertEqual(
            set(tools["navigate"].input_schema["properties"]),
            {"tid", "url", "timeout", "bid"},
        )
        self.assertEqual(tools["navigate"].input_schema["required"], ["url"])
        self.assertEqual(
            set(tools["scroll"].input_schema["required"]),
            {"tid", "y"},
        )
        self.assertEqual(
            set(tools["screenshot"].input_schema["properties"]),
            {"tid", "full_page", "timeout", "bid"},
        )
        self.assertEqual(
            set(tools["screenshot"].input_schema["required"]),
            {"tid"},
        )
        self.assertEqual(
            set(tools["record"].input_schema["properties"]),
            {"method", "tid", "full_page", "timeout", "bid"},
        )
        self.assertEqual(
            set(tools["record"].input_schema["required"]),
            {"method", "tid"},
        )
        self.assertEqual(
            set(tools["console"].input_schema["properties"]),
            {"method", "tid", "timeout", "bid"},
        )
        self.assertEqual(
            set(tools["console"].input_schema["required"]),
            {"method", "tid"},
        )
        self.assertEqual(
            set(tools["proxy"].input_schema["properties"]),
            {"method", "proxy", "timeout", "bid"},
        )
        self.assertEqual(
            set(tools["proxy"].input_schema["required"]),
            {"method"},
        )
        self.assertEqual(
            set(tools["cleanup"].input_schema["properties"]),
            {"timeout", "bid"},
        )
        self.assertEqual(tools["cleanup"].input_schema.get("required", []), [])
        self.assertEqual(
            set(tools["execute_batch"].input_schema["properties"]),
            {"actions", "timeout", "bid"},
        )
        self.assertEqual(tools["execute_batch"].input_schema["required"], ["actions"])
        self.assertNotIn("tabs", tools)
        self.assertNotIn("reload_extension", tools)

    async def test_calls_client_and_returns_typed_structured_content(self) -> None:
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
                "bid": None,
            },
        )
        self.acob.click.assert_awaited_once_with(
            12,
            "button",
            timeout=4.5,
            bid=None,
        )

    async def test_rejects_coerced_and_unknown_arguments(self) -> None:
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

    async def test_root_tab_tools_route_to_client_methods(self) -> None:
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
        self.acob.list.assert_awaited_once_with(timeout=None, bid=None)
        self.acob.navigate.assert_awaited_once_with(
            "https://example.com/new",
            tid=12,
            timeout=None,
            bid=None,
        )
        self.acob.focus.assert_awaited_once_with(12, timeout=None, bid=None)
        self.acob.close.assert_awaited_once_with(12, timeout=None, bid=None)
        self.acob.reload.assert_awaited_once_with(12, timeout=None, bid=None)
        self.acob.scroll.assert_awaited_once_with(12, 500, timeout=None, bid=None)

    async def test_keyboard_enforces_exclusive_input(self) -> None:
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
            bid=None,
        )

    async def test_keyboard_inserts_text_through_the_client(self) -> None:
        self.acob.keyboard.return_value = KeyboardTextResult(inserted_characters=5)

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool(
                "keyboard",
                {"tid": 12, "text": "hello", "timeout": 3.0},
            )

        self.assertFalse(result.is_error)
        self.assertEqual(
            result.structured_content,
            {"result": {"inserted_characters": 5, "bid": None}},
        )
        self.acob.keyboard.assert_awaited_once_with(
            12,
            text="hello",
            timeout=3.0,
            bid=None,
        )

    async def test_keyboard_rejects_missing_and_empty_input(self) -> None:
        async with Client(self.server, raise_exceptions=True) as client:
            missing = await client.call_tool("keyboard", {"tid": 12})
            empty = await client.call_tool(
                "keyboard",
                {"tid": 12, "key": ""},
            )

        self.assertTrue(missing.is_error)
        self.assertTrue(empty.is_error)
        self.acob.keyboard.assert_not_awaited()

    async def test_keyboard_rejects_missing_key_when_validator_bypassed(self) -> None:
        with patch("src.server._validate_keyboard"):
            async with Client(self.server, raise_exceptions=True) as client:
                result = await client.call_tool("keyboard", {"tid": 12})

        self.assertTrue(result.is_error)
        self.assertIn("exactly one of text or key is required", _text(result))
        self.acob.keyboard.assert_not_awaited()

    async def test_returns_screenshot_download_url_from_the_client(self) -> None:
        media_url = "http://acob.test/api/media/screenshot-12-abc.png"
        self.acob.screenshot.return_value = Screenshot(
            url=media_url,
            content_type="image/png",
            full_page=True,
            tid=12,
        )

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool(
                "screenshot",
                {"tid": 12, "full_page": True},
            )

        self.assertFalse(result.is_error)
        self.assertEqual(
            result.structured_content,
            {
                "url": media_url,
                "content_type": "image/png",
                "full_page": True,
                "tid": 12,
                "bid": None,
            },
        )
        self.acob.screenshot.assert_awaited_once_with(
            12,
            full_page=True,
            timeout=None,
            bid=None,
        )

    async def test_starts_and_stops_recordings_through_the_client(self) -> None:
        self.acob.record.return_value = RecordingStart(
            started=True,
            tid=12,
        )

        async with Client(self.server, raise_exceptions=True) as client:
            started = await client.call_tool(
                "record",
                {"method": "start", "tid": 12, "full_page": True},
            )

        self.assertFalse(started.is_error)
        self.assertEqual(
            started.structured_content,
            {"result": {"started": True, "tid": 12, "bid": None}},
        )
        self.acob.record.assert_awaited_once_with(
            "start",
            12,
            full_page=True,
            timeout=None,
            bid=None,
        )

    async def test_stops_recordings_through_the_client(self) -> None:
        self.acob.record.return_value = RecordingStop(
            url="http://acob.test/api/media/screenshot-12-abc.png",
            content_type="video/webm",
            duration=300.0,
            stopped_reason="max_duration",
            message="Recording stopped because the maximum duration was reached",
            tid=12,
        )

        async with Client(self.server, raise_exceptions=True) as client:
            stopped = await client.call_tool("record", {"method": "stop", "tid": 12})

        self.assertFalse(stopped.is_error)
        self.assertEqual(
            stopped.structured_content,
            {
                "result": {
                    "url": "http://acob.test/api/media/screenshot-12-abc.png",
                    "content_type": "video/webm",
                    "duration": 300.0,
                    "stopped_reason": "max_duration",
                    "message": (
                        "Recording stopped because the maximum duration was reached"
                    ),
                    "tid": 12,
                    "bid": None,
                }
            },
        )
        self.acob.record.assert_awaited_once_with("stop", 12, timeout=None, bid=None)

    async def test_record_rejects_stop_with_full_page(self) -> None:
        async with Client(self.server, raise_exceptions=True) as client:
            invalid = await client.call_tool(
                "record", {"method": "stop", "tid": 12, "full_page": True}
            )

        self.assertTrue(invalid.is_error)
        self.acob.record.assert_not_awaited()

    async def test_starts_console_capture_through_the_client(self) -> None:
        self.acob.console.return_value = ConsoleStarted(
            started=True,
            tid=12,
        )

        async with Client(self.server, raise_exceptions=True) as client:
            started = await client.call_tool(
                "console",
                {"method": "start", "tid": 12},
            )

        self.assertFalse(started.is_error)
        self.assertEqual(
            started.structured_content,
            {"result": {"started": True, "tid": 12, "bid": None}},
        )
        self.acob.console.assert_awaited_once_with(
            "start",
            12,
            timeout=None,
            bid=None,
        )

    async def test_captures_console_snapshot_through_the_client(self) -> None:
        self.acob.console.return_value = ConsoleCapture(
            url="http://acob.test/api/media/console-12-abc.json",
            content_type="application/json",
            entries=3,
            size_bytes=1234,
            truncated=False,
            tid=12,
        )

        async with Client(self.server, raise_exceptions=True) as client:
            captured = await client.call_tool(
                "console", {"method": "capture", "tid": 12}
            )

        self.assertFalse(captured.is_error)
        self.assertEqual(
            captured.structured_content,
            {
                "result": {
                    "url": "http://acob.test/api/media/console-12-abc.json",
                    "content_type": "application/json",
                    "entries": 3,
                    "size_bytes": 1234,
                    "truncated": False,
                    "tid": 12,
                    "bid": None,
                }
            },
        )
        self.acob.console.assert_awaited_once_with(
            "capture", 12, timeout=None, bid=None
        )

    async def test_stops_console_capture_through_the_client(self) -> None:
        self.acob.console.return_value = ConsoleCapture(
            url="http://acob.test/api/media/console-12-abc.json",
            content_type="application/json",
            entries=5,
            size_bytes=2048,
            truncated=True,
            tid=12,
        )

        async with Client(self.server, raise_exceptions=True) as client:
            stopped = await client.call_tool("console", {"method": "stop", "tid": 12})

        self.assertFalse(stopped.is_error)
        self.assertEqual(
            stopped.structured_content,
            {
                "result": {
                    "url": "http://acob.test/api/media/console-12-abc.json",
                    "content_type": "application/json",
                    "entries": 5,
                    "size_bytes": 2048,
                    "truncated": True,
                    "tid": 12,
                    "bid": None,
                }
            },
        )
        self.acob.console.assert_awaited_once_with("stop", 12, timeout=None, bid=None)

    async def test_console_rejects_invalid_method(self) -> None:
        async with Client(self.server, raise_exceptions=True) as client:
            invalid = await client.call_tool(
                "console",
                {"method": "bogus", "tid": 12},
            )

        self.assertTrue(invalid.is_error)
        self.acob.console.assert_not_awaited()

    async def test_sets_and_unsets_proxy_through_the_client(self) -> None:
        self.acob.proxy.return_value = ProxySet(
            proxied=True,
            scheme="http",
            host="127.0.0.1",
            port=8080,
            authenticated=False,
        )

        async with Client(self.server, raise_exceptions=True) as client:
            set_result = await client.call_tool(
                "proxy", {"method": "set", "proxy": "http://127.0.0.1:8080"}
            )

        self.assertFalse(set_result.is_error)
        self.assertEqual(
            set_result.structured_content,
            {
                "result": {
                    "proxied": True,
                    "scheme": "http",
                    "host": "127.0.0.1",
                    "port": 8080,
                    "authenticated": False,
                    "bid": None,
                }
            },
        )
        self.acob.proxy.assert_awaited_once_with(
            "set", proxy="http://127.0.0.1:8080", timeout=None, bid=None
        )

    async def test_unsets_proxy_through_the_client(self) -> None:
        self.acob.proxy.return_value = ProxyUnset(proxied=False)

        async with Client(self.server, raise_exceptions=True) as client:
            unset_result = await client.call_tool("proxy", {"method": "unset"})

        self.assertFalse(unset_result.is_error)
        self.assertEqual(
            unset_result.structured_content,
            {"result": {"proxied": False, "bid": None}},
        )
        self.acob.proxy.assert_awaited_once_with("unset", timeout=None, bid=None)

    async def test_proxy_rejects_unset_with_proxy_string(self) -> None:
        async with Client(self.server, raise_exceptions=True) as client:
            invalid = await client.call_tool(
                "proxy",
                {"method": "unset", "proxy": "http://127.0.0.1:8080"},
            )

        self.assertTrue(invalid.is_error)
        self.acob.proxy.assert_not_awaited()

    async def test_cleans_up_through_the_client(self) -> None:
        self.acob.cleanup.return_value = CleanupResult(cleaned=True)

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool("cleanup", {})

        self.assertFalse(result.is_error)
        self.assertEqual(result.structured_content, {"cleaned": True, "bid": None})
        self.acob.cleanup.assert_awaited_once_with(timeout=None, bid=None)

    async def test_cleanup_rejects_unknown_arguments(self) -> None:
        async with Client(self.server, raise_exceptions=True) as client:
            with self.assertRaisesRegex(MCPError, "Unexpected argument"):
                await client.call_tool(
                    "cleanup",
                    {"unexpected": True},
                )

        self.acob.cleanup.assert_not_awaited()

    async def test_returns_javascript_json_values(self) -> None:
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

    async def test_reinstall_is_explicitly_destructive(self) -> None:
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

    async def test_execute_batch_runs_actions_sequentially_through_the_client(
        self,
    ) -> None:
        self.acob.execute_batch.return_value = [
            BatchResultEntry(result=[]),
            BatchResultEntry(error="No element matches selector: button"),
        ]

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool(
                "execute_batch",
                {
                    "actions": [
                        {"action": "list"},
                        {"action": "click", "tid": 12, "selector": "button"},
                    ]
                },
            )
            with self.assertRaisesRegex(MCPError, "Unexpected argument"):
                await client.call_tool(
                    "execute_batch",
                    {"actions": [{"action": "list"}], "unexpected": True},
                )

        self.assertFalse(result.is_error)
        self.assertEqual(
            result.structured_content,
            {
                "result": [
                    {"error": None, "result": [], "bid": None},
                    {
                        "error": "No element matches selector: button",
                        "result": None,
                        "bid": None,
                    },
                ]
            },
        )
        self.acob.execute_batch.assert_awaited_once_with(
            [
                {"action": "list"},
                {"action": "click", "tid": 12, "selector": "button"},
            ],
            timeout=None,
            bid=None,
        )

    async def test_bid_passes_through_to_the_client(self) -> None:
        target = "e" * 32
        tab = Tab(
            tid=12,
            window_id=1,
            active=True,
            title="Example",
            url="https://example.com",
            domain="example.com",
            bid=target,
        )
        self.acob.focus.return_value = tab
        self.acob.cleanup.return_value = CleanupResult(cleaned=True, bid=target)

        async with Client(self.server, raise_exceptions=True) as client:
            focused = await client.call_tool("focus", {"tid": 12, "bid": target})
            cleaned = await client.call_tool("cleanup", {"bid": target})
            batched = await client.call_tool(
                "execute_batch",
                {
                    "actions": [{"action": "list"}],
                    "bid": target,
                },
            )

        self.assertFalse(focused.is_error)
        self.assertEqual(focused.structured_content["bid"], target)
        self.assertFalse(cleaned.is_error)
        self.acob.focus.assert_awaited_once_with(12, timeout=None, bid=target)
        self.acob.cleanup.assert_awaited_once_with(timeout=None, bid=target)
        self.acob.execute_batch.assert_awaited_once_with(
            [{"action": "list"}], timeout=None, bid=target
        )
        self.assertFalse(batched.is_error)

    async def test_bid_rejects_malformed_values(self) -> None:
        async with Client(self.server, raise_exceptions=True) as client:
            invalid = await client.call_tool("focus", {"tid": 12, "bid": "not-a-bid"})

        self.assertTrue(invalid.is_error)
        self.acob.focus.assert_not_awaited()

    async def test_instructions_document_bid_affinity(self) -> None:
        self.assertIn("bid", SERVER_INSTRUCTIONS)
        self.assertIn("Untargeted", SERVER_INSTRUCTIONS)

    async def test_client_failures_become_visible_tool_errors(self) -> None:
        self.acob.click.side_effect = RuntimeError("browser is unavailable")

        async with Client(self.server, raise_exceptions=True) as client:
            result = await client.call_tool(
                "click",
                {"tid": 12, "selector": "button"},
            )

        self.assertTrue(result.is_error)
        self.assertIn("browser is unavailable", _text(result))

    async def test_closes_the_acob_client_with_server_lifespan(self) -> None:
        async with Client(self.server, raise_exceptions=True):
            pass

        self.acob.aclose.assert_awaited_once_with()


def _text(result: CallToolResult) -> str:
    content = result.content[0]
    assert isinstance(content, TextContent)
    return content.text


if __name__ == "__main__":
    unittest.main()
