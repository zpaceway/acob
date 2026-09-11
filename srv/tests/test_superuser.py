from __future__ import annotations

import os
from io import StringIO
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core.management import call_command
from django.test import TestCase


class EnsureSuperuserCommandTests(TestCase):
    def test_creates_default_superuser_and_warns_without_password(self) -> None:
        out = StringIO()
        with patch.dict(os.environ, {}, clear=True):
            call_command("ensure_superuser", stdout=out)

        user = User.objects.get(username="admin")
        self.assertEqual(user.email, "admin@example.com")
        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)
        self.assertTrue(user.check_password("changeme"))
        self.assertIn("ACOB_SRV_SUPERUSER_PASSWORD is not set", out.getvalue())
        self.assertIn("Ensured superuser 'admin' exists.", out.getvalue())

    def test_uses_environment_values_without_warning(self) -> None:
        out = StringIO()
        env = {
            "ACOB_SRV_SUPERUSER_USERNAME": "operator",
            "ACOB_SRV_SUPERUSER_EMAIL": "ops@example.com",
            "ACOB_SRV_SUPERUSER_PASSWORD": "s3cret",
        }
        with patch.dict(os.environ, env, clear=True):
            call_command("ensure_superuser", stdout=out)

        user = User.objects.get(username="operator")
        self.assertEqual(user.email, "ops@example.com")
        self.assertTrue(user.check_password("s3cret"))
        self.assertNotIn("is not set", out.getvalue())

    def test_updates_an_existing_user(self) -> None:
        User.objects.create_user(
            username="admin",
            email="old@example.com",
            password="old-password",  # noqa: S106
        )
        out = StringIO()
        with patch.dict(
            os.environ,
            {"ACOB_SRV_SUPERUSER_EMAIL": "new@example.com"},
            clear=True,
        ):
            call_command("ensure_superuser", stdout=out)

        user = User.objects.get(username="admin")
        self.assertEqual(user.email, "new@example.com")
        self.assertTrue(user.is_superuser)

    def test_blank_environment_values_fall_back_to_defaults(self) -> None:
        out = StringIO()
        env = {
            "ACOB_SRV_SUPERUSER_USERNAME": "",
            "ACOB_SRV_SUPERUSER_EMAIL": "",
            "ACOB_SRV_SUPERUSER_PASSWORD": "",
        }
        with patch.dict(os.environ, env, clear=True):
            call_command("ensure_superuser", stdout=out)

        user = User.objects.get(username="admin")
        self.assertEqual(user.email, "admin@example.com")
        self.assertTrue(user.check_password("changeme"))
