from __future__ import annotations

from django.test import SimpleTestCase

from acob import asgi, wsgi


class EntryPointTests(SimpleTestCase):
    def test_asgi_application_is_callable(self) -> None:
        self.assertTrue(callable(asgi.application))

    def test_wsgi_application_is_callable(self) -> None:
        self.assertTrue(callable(wsgi.application))
