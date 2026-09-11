from __future__ import annotations

from django.test import SimpleTestCase

from api.schemas import MAX_PROXY_CREDENTIAL_LENGTH, _parse_proxy_string


class ProxyStringParsingTests(SimpleTestCase):
    def test_parses_a_proxy_with_credentials(self) -> None:
        scheme, host, port, authenticated = _parse_proxy_string(
            "socks5://user:pass@127.0.0.1:1080"
        )

        self.assertEqual(
            (scheme, host, port, authenticated), ("socks5", "127.0.0.1", 1080, True)
        )

    def test_rejects_an_unparsable_url(self) -> None:
        with self.assertRaisesRegex(ValueError, "Invalid proxy string"):
            _parse_proxy_string("http://[::1")

    def test_rejects_a_missing_host(self) -> None:
        with self.assertRaisesRegex(ValueError, "host is required"):
            _parse_proxy_string("http://:8080")

    def test_rejects_an_overlong_host(self) -> None:
        with self.assertRaisesRegex(ValueError, "host is required"):
            _parse_proxy_string(f"http://{'a' * 254}:8080")

    def test_rejects_a_non_numeric_port(self) -> None:
        with self.assertRaisesRegex(ValueError, "Invalid proxy string"):
            _parse_proxy_string("http://host:not-a-port")

    def test_rejects_a_query_string(self) -> None:
        with self.assertRaisesRegex(ValueError, "query and fragment"):
            _parse_proxy_string("http://host:8080/?q=1")

    def test_rejects_a_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "path is not allowed"):
            _parse_proxy_string("http://host:8080/proxy")

    def test_rejects_an_overlong_username(self) -> None:
        username = "u" * (MAX_PROXY_CREDENTIAL_LENGTH + 1)
        with self.assertRaisesRegex(ValueError, "invalid credentials"):
            _parse_proxy_string(f"http://{username}:p@host:8080")

    def test_rejects_an_overlong_password(self) -> None:
        password = "p" * (MAX_PROXY_CREDENTIAL_LENGTH + 1)
        with self.assertRaisesRegex(ValueError, "invalid credentials"):
            _parse_proxy_string(f"http://user:{password}@host:8080")
