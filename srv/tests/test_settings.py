from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

from acob.settings import _parse_database_url

SETTINGS_PATH = Path(__file__).resolve().parent.parent / "acob" / "settings.py"


def load_settings(**env: str) -> ModuleType:
    """Execute a fresh copy of settings.py under the given environment."""
    spec = importlib.util.spec_from_file_location(
        "acob._settings_fixture", SETTINGS_PATH
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, env, clear=True):
        spec.loader.exec_module(module)
    return module


class DatabaseUrlParsingTests(SimpleTestCase):
    def test_parses_a_full_url(self) -> None:
        config = _parse_database_url(
            "postgres://user:pass@db.example:5433/my%20db?sslmode=require"
        )

        self.assertEqual(config["ENGINE"], "django.db.backends.postgresql")
        self.assertEqual(config["NAME"], "my db")
        self.assertEqual(config["USER"], "user")
        self.assertEqual(config["PASSWORD"], "pass")
        self.assertEqual(config["HOST"], "db.example")
        self.assertEqual(config["PORT"], "5433")
        self.assertEqual(config["OPTIONS"], {"sslmode": "require"})

    def test_applies_defaults(self) -> None:
        config = _parse_database_url("postgresql://db.example")

        self.assertEqual(config["NAME"], "acob")
        self.assertEqual(config["USER"], "acob")
        self.assertEqual(config["PASSWORD"], "")
        self.assertEqual(config["HOST"], "db.example")
        self.assertEqual(config["PORT"], "5432")
        self.assertNotIn("OPTIONS", config)

    def test_accepts_psycopg_driver_scheme(self) -> None:
        config = _parse_database_url("postgresql+psycopg://db.example/acob")

        self.assertEqual(config["HOST"], "db.example")

    def test_rejects_an_unsupported_scheme(self) -> None:
        with self.assertRaises(ImproperlyConfigured):
            _parse_database_url("mysql://db.example/acob")

    def test_rejects_an_invalid_port(self) -> None:
        with self.assertRaises(ImproperlyConfigured):
            _parse_database_url("postgres://db.example:not-a-port/acob")


class SettingsEnvironmentTests(SimpleTestCase):
    def test_database_url_wins_and_env_secret_is_used(self) -> None:
        module = load_settings(
            ACOB_SRV_DATABASE_URL="postgres://u:p@db.internal:5433/acob",
            ACOB_SRV_SECRET_KEY="from-env",  # noqa: S106
        )

        self.assertTrue(module.DEBUG)
        self.assertEqual(module.SECRET_KEY, "from-env")
        self.assertEqual(module.DATABASES["default"]["HOST"], "db.internal")
        self.assertEqual(module.DATABASES["default"]["PORT"], "5433")

    def test_host_environment_builds_postgres_config(self) -> None:
        module = load_settings(
            ACOB_SRV_DEBUG="yes",
            ACOB_SRV_DB_HOST="db.internal",
            ACOB_SRV_DB_NAME="custom",
            ACOB_SRV_DB_USER="user",
            ACOB_SRV_DB_PASSWORD="pass",  # noqa: S106
            ACOB_SRV_DB_PORT="5555",
        )

        database = module.DATABASES["default"]
        self.assertEqual(database["ENGINE"], "django.db.backends.postgresql")
        self.assertEqual(database["HOST"], "db.internal")
        self.assertEqual(database["NAME"], "custom")
        self.assertEqual(database["USER"], "user")
        self.assertEqual(database["PASSWORD"], "pass")
        self.assertEqual(database["PORT"], "5555")

    def test_sqlite_is_the_fallback(self) -> None:
        module = load_settings(ACOB_SRV_DEBUG="1")

        self.assertEqual(
            module.DATABASES["default"]["ENGINE"],
            "django.db.backends.sqlite3",
        )

    def test_debug_false_without_a_secret_is_rejected(self) -> None:
        with self.assertRaises(ImproperlyConfigured):
            load_settings(ACOB_SRV_DEBUG="false")

    def test_debug_false_uses_the_env_secret(self) -> None:
        module = load_settings(
            ACOB_SRV_DEBUG="false",
            ACOB_SRV_SECRET_KEY="prod-secret",  # noqa: S106
        )

        self.assertFalse(module.DEBUG)
        self.assertEqual(module.SECRET_KEY, "prod-secret")

    def test_allowed_hosts_and_csrf_origins_are_split(self) -> None:
        module = load_settings(
            ACOB_SRV_DEBUG="1",
            ACOB_SRV_ALLOWED_HOSTS="one.test, two.test",
            ACOB_SRV_CSRF_TRUSTED_ORIGINS="https://a.test, https://b.test",
        )

        self.assertEqual(module.ALLOWED_HOSTS, ["one.test", "two.test"])
        self.assertEqual(
            module.CSRF_TRUSTED_ORIGINS,
            ["https://a.test", "https://b.test"],
        )

    def test_blank_allowed_hosts_defaults_to_wildcard(self) -> None:
        module = load_settings(ACOB_SRV_DEBUG="1", ACOB_SRV_ALLOWED_HOSTS=" , ")

        self.assertEqual(module.ALLOWED_HOSTS, ["*"])
