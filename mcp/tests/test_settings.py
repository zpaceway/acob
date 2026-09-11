import os
import runpy
import unittest
from collections.abc import Callable
from unittest.mock import Mock, patch

from mcp.server import MCPServer
from mcp.server.context import HandlerResult, ServerRequestContext
from mcp.types import ListToolsResult, Tool

from src.server import (
    _boolean,
    _enforce_tool_arguments,
    _port,
    _positive_float,
    _required_url,
    _validate_console,
    _validate_keyboard,
    _validate_proxy,
    _validate_record,
)


class RequiredUrlTests(unittest.TestCase):
    def test_accepts_and_normalizes_http_urls(self) -> None:
        self.assertEqual(
            _required_url(
                {"ACOB_MCP_ENDPOINT": "  http://acob.example:58347/  "},
                "ACOB_MCP_ENDPOINT",
            ),
            "http://acob.example:58347",
        )
        self.assertEqual(
            _required_url(
                {"ACOB_MCP_ENDPOINT": "https://acob.example"},
                "ACOB_MCP_ENDPOINT",
            ),
            "https://acob.example",
        )

    def test_rejects_missing_or_unparseable_urls(self) -> None:
        invalid = (
            {},
            {"ACOB_MCP_ENDPOINT": "   "},
            {"ACOB_MCP_ENDPOINT": "not-a-url"},
            {"ACOB_MCP_ENDPOINT": "ftp://acob.example"},
            {"ACOB_MCP_ENDPOINT": "http:///path"},
            {"ACOB_MCP_ENDPOINT": "http://acob.example?q=1"},
            {"ACOB_MCP_ENDPOINT": "http://acob.example#frag"},
            {"ACOB_MCP_ENDPOINT": "http://acob.example:notaport"},
        )
        for environ in invalid:
            with (
                self.subTest(environ=environ),
                self.assertRaisesRegex(
                    ValueError,
                    r"ACOB_MCP_ENDPOINT must be.*valid HTTP or HTTPS URL",
                ),
            ):
                _required_url(environ, "ACOB_MCP_ENDPOINT")


class BooleanTests(unittest.TestCase):
    def test_parses_true_and_false(self) -> None:
        self.assertTrue(_boolean({"FLAG": "true"}, "FLAG"))
        self.assertTrue(_boolean({"FLAG": "TRUE"}, "FLAG"))
        self.assertFalse(_boolean({"FLAG": "false"}, "FLAG"))
        self.assertFalse(_boolean({}, "FLAG"))

    def test_rejects_other_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "FLAG must be true or false"):
            _boolean({"FLAG": "yes"}, "FLAG")


class KeyboardValidationTests(unittest.TestCase):
    def test_accepts_valid_combinations(self) -> None:
        _validate_keyboard("hello", None, None)
        _validate_keyboard(None, "Enter", None)
        _validate_keyboard(None, "Enter", ["ctrl", "shift"])
        _validate_keyboard(None, "a", None)

    def test_rejects_invalid_combinations(self) -> None:
        _assert_invalid(
            _validate_keyboard,
            (None, None, None),
            "exactly one of text or key is required",
        )
        _assert_invalid(
            _validate_keyboard,
            ("hello", "Enter", None),
            "exactly one of text or key is required",
        )
        _assert_invalid(
            _validate_keyboard,
            ("hello", None, ["ctrl"]),
            "modifiers are only valid with key input",
        )
        _assert_invalid(
            _validate_keyboard,
            (None, "Enter", ["ctrl", "ctrl"]),
            "modifiers cannot contain duplicates",
        )
        _assert_invalid(
            _validate_keyboard,
            (None, "NotAKey", None),
            "key must be a supported named key or one character",
        )


class RecordValidationTests(unittest.TestCase):
    def test_accepts_valid_recording_requests(self) -> None:
        _validate_record("start", full_page=True)
        _validate_record("start", full_page=False)
        _validate_record("stop", full_page=False)

    def test_rejects_invalid_recording_requests(self) -> None:
        _assert_invalid(
            _validate_record,
            ("bogus",),
            "method must be 'start' or 'stop'",
            full_page=False,
        )
        _assert_invalid(
            _validate_record,
            ("stop",),
            "full_page is only valid when method is 'start'",
            full_page=True,
        )


class ConsoleValidationTests(unittest.TestCase):
    def test_accepts_valid_console_methods(self) -> None:
        for method in ("start", "capture", "stop"):
            _validate_console(method)

    def test_rejects_invalid_console_methods(self) -> None:
        _assert_invalid(
            _validate_console,
            ("bogus",),
            "method must be 'start', 'capture' or 'stop'",
        )


class ProxyValidationTests(unittest.TestCase):
    def test_accepts_valid_proxy_requests(self) -> None:
        _validate_proxy("set", "http://127.0.0.1:8080")
        _validate_proxy("unset", None)

    def test_rejects_invalid_proxy_requests(self) -> None:
        _assert_invalid(
            _validate_proxy,
            ("bogus", None),
            "method must be 'set' or 'unset'",
        )
        _assert_invalid(
            _validate_proxy,
            ("set", None),
            "proxy is required when method is 'set'",
        )
        _assert_invalid(
            _validate_proxy,
            ("set", "   "),
            "proxy is required when method is 'set'",
        )
        _assert_invalid(
            _validate_proxy,
            ("unset", "http://127.0.0.1:8080"),
            "proxy must not be provided when method is 'unset'",
        )


class PositiveFloatTests(unittest.TestCase):
    def test_returns_value_or_default(self) -> None:
        self.assertEqual(_positive_float({}, "VALUE", 2.5), 2.5)
        self.assertEqual(_positive_float({"VALUE": "3.5"}, "VALUE", 2.5), 3.5)

    def test_rejects_non_numeric_and_non_positive_values(self) -> None:
        for raw in ("abc", "nan", "inf", "-1", "0"):
            with (
                self.subTest(raw=raw),
                self.assertRaisesRegex(
                    ValueError,
                    "VALUE must be a positive finite number",
                ),
            ):
                _positive_float({"VALUE": raw}, "VALUE", 1.0)


class PortTests(unittest.TestCase):
    def test_parses_ports_within_range(self) -> None:
        self.assertEqual(_port("1"), 1)
        self.assertEqual(_port("65535"), 65535)

    def test_rejects_non_integer_and_out_of_range_ports(self) -> None:
        for raw in ("abc", "0", "65536", "-1"):
            with (
                self.subTest(raw=raw),
                self.assertRaisesRegex(
                    ValueError,
                    "ACOB_MCP_PORT must be an integer from 1 to 65535",
                ),
            ):
                _port(raw)


class EnforceToolArgumentsTests(unittest.IsolatedAsyncioTestCase):
    async def test_marks_additional_properties_false_on_list_tools_result(self) -> None:
        managed = Tool(name="list", input_schema={"type": "object"})
        unmanaged = Tool(name="unmanaged", input_schema={"type": "object"})
        result = ListToolsResult(tools=[managed, unmanaged])
        ctx = Mock(spec=ServerRequestContext)
        ctx.method = "tools/list"
        ctx.params = {}

        async def call_next(_ctx: object) -> HandlerResult:
            return result

        returned = await _enforce_tool_arguments(ctx, call_next)

        self.assertIs(returned, result)
        self.assertFalse(managed.input_schema["additionalProperties"])
        self.assertNotIn("additionalProperties", unmanaged.input_schema)

    async def test_marks_additional_properties_false_on_plain_dict_result(self) -> None:
        managed = {"name": "list", "inputSchema": {"type": "object"}}
        unmanaged = {"name": "unmanaged", "inputSchema": {"type": "object"}}
        missing_schema = {"name": "click"}
        not_a_tool = "not-a-dict"
        result = {
            "tools": [managed, not_a_tool, unmanaged, missing_schema],
        }
        ctx = Mock(spec=ServerRequestContext)
        ctx.method = "tools/list"
        ctx.params = {}

        async def call_next(_ctx: object) -> HandlerResult:
            return result

        returned = await _enforce_tool_arguments(ctx, call_next)

        self.assertIs(returned, result)
        self.assertFalse(managed["inputSchema"]["additionalProperties"])
        self.assertNotIn("additionalProperties", unmanaged["inputSchema"])
        self.assertNotIn("inputSchema", missing_schema)

    async def test_ignores_dict_results_without_a_tools_list(self) -> None:
        result: dict[str, object] = {"tools": "not-a-list"}
        ctx = Mock(spec=ServerRequestContext)
        ctx.method = "tools/list"
        ctx.params = {}

        async def call_next(_ctx: object) -> HandlerResult:
            return result

        returned = await _enforce_tool_arguments(ctx, call_next)

        self.assertIs(returned, result)


class MainEntrypointTests(unittest.TestCase):
    def test_module_entrypoint_runs_main(self) -> None:
        with (
            patch.dict(
                os.environ,
                {"ACOB_MCP_ENDPOINT": "http://acob.example:58347"},
                clear=True,
            ),
            patch.object(MCPServer, "run") as run,
        ):
            runpy.run_module("src.server", run_name="__main__")

        run.assert_called_once()

    def test_main_exits_on_invalid_configuration(self) -> None:
        with (
            patch.dict(os.environ, {"ACOB_MCP_ENDPOINT": "not-a-url"}, clear=True),
            patch.object(MCPServer, "run") as run,
            self.assertRaisesRegex(
                SystemExit,
                "Invalid ACOB MCP configuration: "
                "ACOB_MCP_ENDPOINT must be a valid HTTP or HTTPS URL",
            ),
        ):
            runpy.run_module("src.server", run_name="__main__")

        run.assert_not_called()


def _assert_invalid(
    func: Callable[..., object],
    args: tuple[object, ...],
    message: str,
    **kwargs: object,
) -> None:
    test = unittest.TestCase()
    with test.assertRaisesRegex(ValueError, message):
        func(*args, **kwargs)


if __name__ == "__main__":
    unittest.main()
