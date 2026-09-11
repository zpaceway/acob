"""Idempotent default superuser creation for local and testing stacks."""

import os
from typing import cast, override

from django.contrib.auth import get_user_model
from django.contrib.auth.models import User
from django.core.management.base import BaseCommand

DEFAULT_USERNAME = "admin"
DEFAULT_EMAIL = "admin@example.com"
DEFAULT_PASSWORD = "changeme"  # noqa: S105


class Command(BaseCommand):
    help = "Create or update the default superuser from environment variables."

    @override
    def handle(self, *_args: str, **_options: str) -> None:
        username = (
            os.environ.get("ACOB_SRV_SUPERUSER_USERNAME", DEFAULT_USERNAME)
            or DEFAULT_USERNAME
        )
        email = (
            os.environ.get("ACOB_SRV_SUPERUSER_EMAIL", DEFAULT_EMAIL) or DEFAULT_EMAIL
        )
        password = (
            os.environ.get("ACOB_SRV_SUPERUSER_PASSWORD", DEFAULT_PASSWORD)
            or DEFAULT_PASSWORD
        )
        if "ACOB_SRV_SUPERUSER_PASSWORD" not in os.environ:
            self.stdout.write(
                self.style.WARNING(
                    "ACOB_SRV_SUPERUSER_PASSWORD is not set; "
                    f"using default password for {username!r}. "
                    "Change it with `manage.py changepassword`.",
                )
            )
        user_model = cast("type[User]", get_user_model())
        user, _created = user_model.objects.get_or_create(
            username=username,
            defaults={"email": email},
        )
        user.email = email
        user.is_staff = True
        user.is_superuser = True
        user.set_password(password)
        user.save()
        self.stdout.write(
            self.style.SUCCESS(f"Ensured superuser {username!r} exists."),
        )
