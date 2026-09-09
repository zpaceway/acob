import json

from django.http import FileResponse
from django.test import SimpleTestCase, override_settings
from django.urls import resolve

from api.documentation import openapi_document


class DocumentationTests(SimpleTestCase):
    @override_settings(ACOB_PUBLIC_URL="http://media.test:9000")
    def test_links_follow_each_request_not_media_configuration(self) -> None:
        for host, secure in (
            ("localhost:61554", False),
            ("docs.test:8443", True),
            ("[::1]:61554", False),
        ):
            with self.subTest(host=host):
                origin = f"{'https' if secure else 'http'}://{host}"
                response = self.client.get("/api/", HTTP_HOST=host, secure=secure)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response["Cache-Control"], "no-store")
                docs = response.json()
                self.assertEqual(docs["base_url"], origin)
                self.assertEqual(docs["swagger_url"], origin + "/api/docs/")
                self.assertEqual(docs["openapi_url"], origin + "/api/openapi.json")
                self.assertEqual(
                    docs["instruction_url_template"],
                    origin + "/api/instructions/{instruction_id}/",
                )
                schema = self.client.get(
                    "/api/openapi.json", HTTP_HOST=host, secure=secure
                ).json()
                self.assertEqual(schema["servers"], [{"url": origin}])
                self.assertIn(
                    origin + "/api/instructions/", schema["info"]["description"]
                )
                self.assertNotIn("media.test", json.dumps(schema))
                html = self.client.get("/api/docs/", HTTP_HOST=host, secure=secure)
                self.assertContains(html, origin)

    def test_schema_references_resolve_and_routes_exist(self) -> None:
        document = openapi_document("http://docs.test")

        def check(value: object) -> None:
            if isinstance(value, dict):
                ref = value.get("$ref")
                if isinstance(ref, str):
                    target = document
                    for key in ref.removeprefix("#/").split("/"):
                        target = target[key]
                for child in value.values():
                    check(child)
            elif isinstance(value, list):
                for child in value:
                    check(child)

        check(document)
        for path in document["paths"]:
            resolve(
                path.replace("{instruction_id}", "1").replace("{name}", "capture.png")
            )
        models = document["components"]["schemas"]
        self.assertTrue(
            models["ScreenshotInstruction"]["properties"]["full_page"]["default"]
        )
        self.assertEqual(
            models["BatchInstructionRequest"]["properties"]["actions"]["maxItems"], 20
        )
        for branch in document["paths"]["/api/instructions/"]["post"]["requestBody"][
            "content"
        ]["application/json"]["schema"]["oneOf"]:
            self.assertFalse(
                models[branch["$ref"].split("/")[-1]]["additionalProperties"]
            )

    def test_swagger_assets_are_local_and_allowlisted(self) -> None:
        html = self.client.get("/api/docs/")
        self.assertContains(html, 'url: "/api/openapi.json"')
        self.assertContains(html, "validatorUrl: null")
        for name, content_type in (
            ("swagger-ui.css", "text/css"),
            ("swagger-ui-bundle.js", "application/javascript"),
        ):
            response = self.client.get(f"/api/docs/assets/{name}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response["Content-Type"], content_type)
            assert isinstance(response, FileResponse)
            self.assertTrue(b"".join(response))
            response.close()
        self.assertEqual(
            self.client.get("/api/docs/assets/unknown.js").status_code, 404
        )

    def test_documentation_is_read_only(self) -> None:
        for path in ("/api/", "/api/docs/", "/api/openapi.json"):
            self.assertEqual(self.client.post(path).status_code, 405)
