import base64
import json
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from django.conf import settings
from django.core.exceptions import ValidationError
from django.test import TestCase

from .models import Instruction, Reinstall
from .recovery import EXTENSION_REINSTALL_ERROR
from .storage import StorageConnectionError


class InstructionApiTests(TestCase):
    BID = "0123456789ab4def8123456789abcdef"

    def instruction_path(self, suffix=""):
        return f"/api/browsers/{self.BID}/instructions/{suffix}"

    def post_json(self, path, data):
        return self.client.post(
            path,
            data=json.dumps(data),
            content_type="application/json",
        )

    def post_result(self, instruction_id, data):
        return self.post_json(
            self.instruction_path(f"{instruction_id}/result/"),
            data,
        )

    def reinstall_path(self, suffix=""):
        return f"/api/browsers/{self.BID}/reinstall/{suffix}"

    def test_instruction_flow(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "list"},
        )

        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()["bid"], self.BID)
        instruction_id = created.json()["id"]

        next_batch = self.client.get(self.instruction_path("next/"))
        self.assertEqual(next_batch.status_code, 200)
        self.assertEqual(next_batch.headers["Cache-Control"], "no-store")
        self.assertEqual(len(next_batch.json()), 1)
        self.assertEqual(next_batch.json()[0]["id"], instruction_id)
        self.assertEqual(next_batch.json()[0]["status"], "processing")

        completed = self.post_result(
            instruction_id,
            {"result": []},
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["status"], "completed")

        repeated = self.post_result(
            instruction_id,
            {"result": ["should not win"]},
        )
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json()["status"], "completed")
        self.assertEqual(repeated.json()["result"], [])

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["result"], [])
        self.assertEqual(detail.headers["Cache-Control"], "no-store")
        self.assertFalse(Instruction.objects.filter(id=instruction_id).exists())
        self.assertEqual(
            self.client.get(self.instruction_path(f"{instruction_id}/")).status_code,
            404,
        )
        empty_queue = self.client.get(self.instruction_path("next/"))
        self.assertEqual(empty_queue.status_code, 204)
        self.assertEqual(empty_queue.headers["Cache-Control"], "no-store")

    def test_pending_and_processing_reads_are_not_consumed(self):
        instruction = Instruction.objects.create(bid=self.BID, action="list")

        pending = self.client.get(self.instruction_path(f"{instruction.id}/"))
        processing = self.client.get(self.instruction_path("next/")).json()[0]

        self.assertEqual(pending.json()["status"], "pending")
        self.assertEqual(processing["status"], "processing")
        self.assertTrue(Instruction.objects.filter(id=instruction.id).exists())

    def test_browser_queues_are_isolated(self):
        other_bid = "fedcba9876544210a9876543210fedcb"
        created = self.post_json(
            self.instruction_path(),
            {"action": "list"},
        )
        instruction_id = created.json()["id"]
        other_path = f"/api/browsers/{other_bid}/instructions"

        self.assertEqual(self.client.get(f"{other_path}/next/").status_code, 204)
        self.assertEqual(
            self.client.get(f"{other_path}/{instruction_id}/").status_code,
            404,
        )
        self.assertEqual(
            self.client.get(self.instruction_path("next/")).json()[0]["id"],
            instruction_id,
        )

    def test_claims_up_to_the_requested_instruction_limit(self):
        instructions = [
            Instruction.objects.create(bid=self.BID, action="list") for _ in range(6)
        ]

        first_batch = self.client.get(self.instruction_path("next/?limit=4"))
        second_batch = self.client.get(self.instruction_path("next/?limit=4"))

        self.assertEqual(first_batch.status_code, 200)
        self.assertEqual(
            [instruction["id"] for instruction in first_batch.json()],
            [instruction.id for instruction in instructions[:4]],
        )
        self.assertTrue(
            all(
                instruction["status"] == "processing"
                for instruction in first_batch.json()
            )
        )
        self.assertEqual(
            [instruction["id"] for instruction in second_batch.json()],
            [instruction.id for instruction in instructions[4:]],
        )

    def test_pending_reinstall_blocks_instruction_claims(self):
        instruction = Instruction.objects.create(bid=self.BID, action="list")
        reinstall_request = Reinstall.objects.create(bid=self.BID)

        response = self.client.get(self.instruction_path("next/?limit=4"))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(
            response.json(),
            [
                {
                    "action": "reinstall",
                    "payload": {"token": str(reinstall_request.token)},
                }
            ],
        )
        instruction.refresh_from_db()
        self.assertEqual(instruction.status, Instruction.Status.PENDING)

    def test_rejects_invalid_instruction_claim_limits(self):
        for limit in ("0", "21", "invalid"):
            with self.subTest(limit=limit):
                response = self.client.get(
                    self.instruction_path(f"next/?limit={limit}")
                )

                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"], "Invalid request")
                self.assertEqual(response.json()["details"][0]["field"], "limit")

    def test_rejects_invalid_browser_ids(self):
        invalid_bids = (
            "not-a-uuid",
            "00000000000000000000000000000000",
            "01234567-89ab-4def-8123-456789abcdef",
            "0123456789AB4DEF8123456789ABCDEF",
        )

        for bid in invalid_bids:
            with self.subTest(bid=bid):
                response = self.post_json(
                    f"/api/browsers/{bid}/instructions/",
                    {"action": "list"},
                )
                self.assertEqual(response.status_code, 404)

    def test_model_validates_browser_id(self):
        instruction = Instruction(bid="0" * 32, action="list")

        with self.assertRaises(ValidationError):
            instruction.full_clean()

    def test_failed_instruction(self):
        instruction = Instruction.objects.create(bid=self.BID, action="list")
        self.client.get(self.instruction_path("next/"))

        response = self.post_result(
            instruction.id,
            {"error": "Browser is unavailable"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "failed")
        self.assertEqual(response.json()["error"], "Browser is unavailable")

        detail = self.client.get(self.instruction_path(f"{instruction.id}/"))
        self.assertEqual(detail.json()["error"], "Browser is unavailable")
        self.assertFalse(Instruction.objects.filter(id=instruction.id).exists())

    def test_rejects_invalid_instruction(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "javascript", "tid": 12, "script": ""},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "javascript.script")

    def test_rejects_unknown_action(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "unknown"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(
            response.json()["details"][0]["type"],
            "union_tag_invalid",
        )

    def test_does_not_return_processing_instruction(self):
        Instruction.objects.create(
            bid=self.BID,
            action="list",
            status=Instruction.Status.PROCESSING,
        )

        response = self.client.get(self.instruction_path("next/"))

        self.assertEqual(response.status_code, 204)

    def test_accepts_root_tab_actions(self):
        listed = self.post_json(self.instruction_path(), {"action": "list"})
        close_tab = self.post_json(
            self.instruction_path(),
            {"action": "close", "tid": 12},
        )
        focus_tab = self.post_json(
            self.instruction_path(),
            {"action": "focus", "tid": 12},
        )
        navigate_new_tab = self.post_json(
            self.instruction_path(),
            {
                "action": "navigate",
                "url": "https://example.com/new",
            },
        )
        navigate_existing_tab = self.post_json(
            self.instruction_path(),
            {
                "action": "navigate",
                "tid": 12,
                "url": "https://example.com/existing",
            },
        )
        reloaded = self.post_json(
            self.instruction_path(),
            {"action": "reload", "tid": 12},
        )
        scrolled = self.post_json(
            self.instruction_path(),
            {"action": "scroll", "tid": 12, "y": -500},
        )

        self.assertEqual(listed.status_code, 201)
        self.assertEqual(listed.json()["payload"], {})
        self.assertEqual(close_tab.status_code, 201)
        self.assertEqual(close_tab.json()["action"], "close")
        self.assertEqual(close_tab.json()["payload"]["tid"], 12)
        self.assertEqual(focus_tab.status_code, 201)
        self.assertEqual(focus_tab.json()["action"], "focus")
        self.assertEqual(focus_tab.json()["payload"]["tid"], 12)
        self.assertEqual(navigate_new_tab.status_code, 201)
        self.assertNotIn("tid", navigate_new_tab.json()["payload"])
        self.assertEqual(navigate_existing_tab.status_code, 201)
        self.assertEqual(navigate_existing_tab.json()["payload"]["tid"], 12)
        self.assertEqual(reloaded.status_code, 201)
        self.assertEqual(reloaded.json()["action"], "reload")
        self.assertEqual(scrolled.status_code, 201)
        self.assertEqual(scrolled.json()["payload"], {"tid": 12, "y": -500.0})

    def test_rejects_legacy_grouped_tabs_action(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "list"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["type"], "union_tag_invalid")

    def test_targeted_tab_actions_require_tid(self):
        for action in ("close", "focus", "reload", "scroll"):
            payload: dict[str, str | int] = {"action": action}
            if action == "scroll":
                payload["y"] = 500
            with self.subTest(action=action):
                response = self.post_json(self.instruction_path(), payload)

                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"], "Invalid request")
                self.assertEqual(
                    response.json()["details"][0]["field"],
                    f"{action}.tid",
                )

    def test_list_rejects_tab_fields(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "list", "tid": 12},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "list.tid")
        self.assertEqual(response.json()["details"][0]["type"], "extra_forbidden")

    def test_navigate_requires_url(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "navigate"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "navigate.url")

    def test_navigate_rejects_empty_url(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "navigate", "url": "  "},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "navigate.url")

    def test_scroll_requires_a_finite_number(self):
        for y in ("500", float("inf"), float("-inf"), float("nan")):
            with self.subTest(y=y):
                response = self.post_json(
                    self.instruction_path(),
                    {"action": "scroll", "tid": 12, "y": y},
                )

                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json()["details"][0]["field"],
                    "scroll.y",
                )

    def test_rejects_result_with_error(self):
        instruction = Instruction.objects.create(bid=self.BID, action="list")
        self.client.get(self.instruction_path("next/"))

        response = self.post_result(
            instruction.id,
            {"result": [], "error": "Browser is unavailable"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "body")

    def test_rejects_non_finite_scroll_result(self):
        instruction = Instruction.objects.create(
            bid=self.BID,
            action="scroll",
            payload={"tid": 12, "y": 500},
            status=Instruction.Status.PROCESSING,
        )

        response = self.post_result(
            instruction.id,
            {"result": {"scrolled": True, "y": float("inf")}},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "y")
        instruction.refresh_from_db()
        self.assertEqual(instruction.status, Instruction.Status.PROCESSING)

    def test_accepts_javascript_instruction(self):
        response = self.post_json(
            self.instruction_path(),
            {
                "action": "javascript",
                "tid": 12,
                "script": "document.title",
            },
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["action"], "javascript")
        self.assertEqual(response.json()["payload"]["script"], "document.title")

    def test_javascript_requires_target_tab(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "javascript", "script": "document.title"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "javascript.tid")

    def test_accepts_click_instruction(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "click", "tid": 12, "selector": "button[type=submit]"},
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["action"], "click")
        self.assertEqual(response.json()["payload"]["tid"], 12)
        self.assertEqual(response.json()["payload"]["selector"], "button[type=submit]")

    def test_click_requires_target_tab(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "click", "selector": "button"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "click.tid")

    def test_click_requires_non_empty_selector(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "click", "tid": 12, "selector": "  "},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "click.selector")

    def test_accepts_keyboard_text_and_key_instructions(self):
        text = self.post_json(
            self.instruction_path(),
            {"action": "keyboard", "tid": 12, "text": " ACOB "},
        )
        key = self.post_json(
            self.instruction_path(),
            {
                "action": "keyboard",
                "tid": 12,
                "key": "a",
                "modifiers": ["ctrl", "shift"],
            },
        )

        self.assertEqual(text.status_code, 201)
        self.assertEqual(text.json()["payload"]["text"], " ACOB ")
        self.assertEqual(key.status_code, 201)
        self.assertEqual(key.json()["payload"]["key"], "a")
        self.assertEqual(key.json()["payload"]["modifiers"], ["ctrl", "shift"])

    def test_keyboard_requires_exactly_one_input(self):
        missing = self.post_json(
            self.instruction_path(),
            {"action": "keyboard", "tid": 12},
        )
        both = self.post_json(
            self.instruction_path(),
            {"action": "keyboard", "tid": 12, "text": "a", "key": "a"},
        )

        self.assertEqual(missing.status_code, 400)
        self.assertEqual(both.status_code, 400)

    def test_keyboard_rejects_invalid_modifiers_and_keys(self):
        text_modifiers = self.post_json(
            self.instruction_path(),
            {
                "action": "keyboard",
                "tid": 12,
                "text": "a",
                "modifiers": ["ctrl"],
            },
        )
        duplicate_modifiers = self.post_json(
            self.instruction_path(),
            {
                "action": "keyboard",
                "tid": 12,
                "key": "Enter",
                "modifiers": ["shift", "shift"],
            },
        )
        unsupported_key = self.post_json(
            self.instruction_path(),
            {"action": "keyboard", "tid": 12, "key": "Return"},
        )

        self.assertEqual(text_modifiers.status_code, 400)
        self.assertEqual(duplicate_modifiers.status_code, 400)
        self.assertEqual(unsupported_key.status_code, 400)

    def test_accepts_screenshot_instruction(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "screenshot", "tid": 12, "full_page": True},
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["payload"], {"tid": 12, "full_page": True})

    def test_screenshot_requires_target_tab(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "screenshot"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "screenshot.tid")

    def test_screenshot_result_is_uploaded_to_the_storage_service(self):
        image = b"\x89PNG\r\n\x1a\nACOB"
        encoded = base64.b64encode(image).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "screenshot", "tid": 12, "full_page": True},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            patch("api.views.create_storage_backend") as create_backend,
            patch.object(settings, "STORAGE_PROVIDER", "chipf"),
            patch.object(
                settings,
                "STORAGE_CONFIG",
                {"chipf": {"endpoint": "https://chipf.test", "api_key": "secret"}},
            ),
        ):
            backend = create_backend.return_value
            backend.upload_file.return_value = (
                "https://chipf.test/api/files/638a5f9f16a24e1fbb4b3ab093016ec7"
            )
            completed = self.post_result(
                instruction_id,
                {"result": {"data": encoded}},
            )

        self.assertEqual(completed.status_code, 200)
        result = completed.json()["result"]
        self.assertEqual(
            result,
            {
                "url": "https://chipf.test/api/files/638a5f9f16a24e1fbb4b3ab093016ec7",
                "content_type": "image/png",
                "full_page": True,
            },
        )
        create_backend.assert_called_once_with(
            "chipf",
            {"chipf": {"endpoint": "https://chipf.test", "api_key": "secret"}},
        )
        backend.upload_file.assert_called_once_with(
            image,
            "screenshot-12.png",
            "image/png",
        )

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["result"], result)
        self.assertFalse(Instruction.objects.filter(id=instruction_id).exists())

    def test_screenshot_fails_when_no_storage_service_is_configured(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "screenshot", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with patch("api.views.create_storage_backend", return_value=None):
            completed = self.post_result(
                instruction_id,
                {"result": {"data": base64.b64encode(b"image").decode()}},
            )

        self.assertEqual(completed.status_code, 200)
        response = completed.json()
        self.assertEqual(response["status"], "failed")
        self.assertIn("no storage service is configured", response["error"])

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["error"], response["error"])
        self.assertFalse(Instruction.objects.filter(id=instruction_id).exists())

    def test_screenshot_fails_when_the_storage_service_is_unavailable(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "screenshot", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with patch("api.views.create_storage_backend") as create_backend:
            backend = create_backend.return_value
            backend.upload_file.side_effect = StorageConnectionError("storage is down")
            completed = self.post_result(
                instruction_id,
                {"result": {"data": base64.b64encode(b"image").decode()}},
            )

        self.assertEqual(completed.status_code, 200)
        response = completed.json()
        self.assertEqual(response["status"], "failed")
        self.assertIn("Could not host the screenshot", response["error"])
        self.assertIn("storage is down", response["error"])

    def test_rejects_invalid_screenshot_result(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "screenshot", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        response = self.post_result(
            instruction_id,
            {"result": {"data": "not base64!"}},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid screenshot data")

    def test_accepts_record_start_and_record_stop_instructions(self):
        started = self.post_json(
            self.instruction_path(),
            {"action": "record_start", "tid": 12},
        )
        stopped = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
        )

        self.assertEqual(started.status_code, 201)
        self.assertEqual(
            started.json()["payload"],
            {"tid": 12, "full_page": False},
        )
        self.assertEqual(stopped.status_code, 201)
        self.assertEqual(stopped.json()["payload"], {"recording_id": 42})

    def test_record_start_accepts_full_page_flag(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "record_start", "tid": 12, "full_page": True},
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            response.json()["payload"],
            {"tid": 12, "full_page": True},
        )

        invalid = self.post_json(
            self.instruction_path(),
            {"action": "record_start", "tid": 12, "full_page": "yes"},
        )
        self.assertEqual(invalid.status_code, 400)

    def test_record_instructions_require_valid_arguments(self):
        missing_tid = self.post_json(
            self.instruction_path(),
            {"action": "record_start"},
        )
        missing_recording_id = self.post_json(
            self.instruction_path(),
            {"action": "record_stop"},
        )
        invalid_recording_id = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 0},
        )

        self.assertEqual(missing_tid.status_code, 400)
        self.assertEqual(
            missing_tid.json()["details"][0]["field"],
            "record_start.tid",
        )
        self.assertEqual(missing_recording_id.status_code, 400)
        self.assertEqual(
            missing_recording_id.json()["details"][0]["field"],
            "record_stop.recording_id",
        )
        self.assertEqual(invalid_recording_id.status_code, 400)

    def test_record_start_result_is_validated(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "record_start", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        completed = self.post_result(
            instruction_id,
            {"result": {"recording_id": 42, "started": True}},
        )

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(
            completed.json()["result"],
            {"recording_id": 42, "started": True},
        )

        invalid = self.post_json(
            self.instruction_path(),
            {"action": "record_start", "tid": 12},
        )
        invalid_id = invalid.json()["id"]
        self.client.get(self.instruction_path("next/"))
        rejected = self.post_result(
            invalid_id,
            {"result": {"recording_id": 0, "started": True}},
        )
        self.assertEqual(rejected.status_code, 400)

    def test_record_stop_result_is_uploaded_to_the_storage_service(self):
        recording = b"0\x9awEBMACOB"
        encoded = base64.b64encode(recording).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            patch("api.views.create_storage_backend") as create_backend,
            patch.object(settings, "STORAGE_PROVIDER", "chipf"),
            patch.object(
                settings,
                "STORAGE_CONFIG",
                {"chipf": {"endpoint": "https://chipf.test", "api_key": "secret"}},
            ),
        ):
            backend = create_backend.return_value
            backend.upload_file.return_value = (
                "https://chipf.test/api/files/638a5f9f16a24e1fbb4b3ab093016ec7"
            )
            completed = self.post_result(
                instruction_id,
                {
                    "result": {
                        "data": encoded,
                        "content_type": "video/webm",
                        "duration": 5.0,
                        "stopped_reason": "max_duration",
                        "message": (
                            "Recording stopped because the maximum duration "
                            "was reached"
                        ),
                    }
                },
            )

        self.assertEqual(completed.status_code, 200)
        result = completed.json()["result"]
        self.assertEqual(
            result,
            {
                "url": "https://chipf.test/api/files/638a5f9f16a24e1fbb4b3ab093016ec7",
                "content_type": "video/webm",
                "duration": 5.0,
                "stopped_reason": "max_duration",
                "message": (
                    "Recording stopped because the maximum duration was reached"
                ),
            },
        )
        backend.upload_file.assert_called_once_with(
            recording,
            "recording-42.webm",
            "video/webm",
        )

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["result"], result)
        self.assertFalse(Instruction.objects.filter(id=instruction_id).exists())

    def test_record_stop_fails_when_no_storage_service_is_configured(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with patch("api.views.create_storage_backend", return_value=None):
            completed = self.post_result(
                instruction_id,
                {
                    "result": {
                        "data": base64.b64encode(b"video").decode(),
                        "content_type": "video/webm",
                        "duration": 1.0,
                        "stopped_reason": "user",
                        "message": "Recording stopped by user request",
                    }
                },
            )

        self.assertEqual(completed.status_code, 200)
        response = completed.json()
        self.assertEqual(response["status"], "failed")
        self.assertIn("no storage service is configured", response["error"])

    def test_record_stop_fails_when_the_storage_service_is_unavailable(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with patch("api.views.create_storage_backend") as create_backend:
            backend = create_backend.return_value
            backend.upload_file.side_effect = StorageConnectionError("storage is down")
            completed = self.post_result(
                instruction_id,
                {
                    "result": {
                        "data": base64.b64encode(b"video").decode(),
                        "content_type": "video/webm",
                        "duration": 1.0,
                        "stopped_reason": "user",
                        "message": "Recording stopped by user request",
                    }
                },
            )

        self.assertEqual(completed.status_code, 200)
        response = completed.json()
        self.assertEqual(response["status"], "failed")
        self.assertIn("Could not host the recording", response["error"])
        self.assertIn("storage is down", response["error"])

    def test_rejects_invalid_record_stop_result(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        bad_base64 = self.post_result(
            instruction_id,
            {
                "result": {
                    "data": "not base64!",
                    "content_type": "video/webm",
                    "duration": 1.0,
                    "stopped_reason": "user",
                    "message": "Recording stopped by user request",
                }
            },
        )
        self.assertEqual(bad_base64.status_code, 400)
        self.assertEqual(bad_base64.json()["error"], "Invalid recording data")

        created = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))
        bad_reason = self.post_result(
            instruction_id,
            {
                "result": {
                    "data": base64.b64encode(b"video").decode(),
                    "content_type": "video/webm",
                    "duration": 1.0,
                    "stopped_reason": "unscheduled",
                    "message": "Recording stopped by user request",
                }
            },
        )
        self.assertEqual(bad_reason.status_code, 400)

    def test_record_stop_result_accepts_mp4_content_type(self):
        recording = b"0\x9awMP4ACOB"
        encoded = base64.b64encode(recording).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            patch("api.views.create_storage_backend") as create_backend,
            patch.object(settings, "STORAGE_PROVIDER", "chipf"),
            patch.object(
                settings,
                "STORAGE_CONFIG",
                {"chipf": {"endpoint": "https://chipf.test", "api_key": "secret"}},
            ),
        ):
            backend = create_backend.return_value
            backend.upload_file.return_value = (
                "https://chipf.test/api/files/638a5f9f16a24e1fbb4b3ab093016ec7"
            )
            completed = self.post_result(
                instruction_id,
                {
                    "result": {
                        "data": encoded,
                        "content_type": "video/mp4",
                        "duration": 5.0,
                        "stopped_reason": "user",
                        "message": "Recording stopped by user request",
                    }
                },
            )

        self.assertEqual(completed.status_code, 200)
        result = completed.json()["result"]
        self.assertEqual(result["content_type"], "video/mp4")
        self.assertEqual(result["duration"], 5.0)
        self.assertEqual(result["stopped_reason"], "user")
        backend.upload_file.assert_called_once_with(
            recording,
            "recording-42.mp4",
            "video/mp4",
        )

    def test_rejects_unknown_record_stop_content_type(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        bad_type = self.post_result(
            instruction_id,
            {
                "result": {
                    "data": base64.b64encode(b"video").decode(),
                    "content_type": "video/avi",
                    "duration": 1.0,
                    "stopped_reason": "user",
                    "message": "Recording stopped by user request",
                }
            },
        )
        self.assertEqual(bad_type.status_code, 400)

    def test_heartbeat_stores_and_returns_browser_settings(self):
        settings_url = f"/api/browsers/{self.BID}/settings/"
        not_reported = self.client.get(settings_url)
        self.assertEqual(not_reported.status_code, 404)

        heartbeat = self.post_json(
            f"/api/browsers/{self.BID}/heartbeat/",
            {
                "settings": {
                    "pollIntervalMs": 1000,
                    "maxRecordingDurationSec": 300,
                    "maxRecordingSizeMiB": 512,
                }
            },
        )
        self.assertEqual(heartbeat.status_code, 204)

        reported = self.client.get(settings_url)
        self.assertEqual(reported.status_code, 200)
        self.assertEqual(
            reported.json()["settings"],
            {
                "pollIntervalMs": 1000,
                "maxRecordingDurationSec": 300,
                "maxRecordingSizeMiB": 512,
            },
        )
        self.assertTrue(reported.json()["updated_at"])

        updated = self.post_json(
            f"/api/browsers/{self.BID}/heartbeat/",
            {"settings": {"pollIntervalMs": 2500}},
        )
        self.assertEqual(updated.status_code, 204)
        self.assertEqual(
            self.client.get(settings_url).json()["settings"],
            {"pollIntervalMs": 2500},
        )

    def test_heartbeat_requires_a_settings_object(self):
        response = self.post_json(
            f"/api/browsers/{self.BID}/heartbeat/",
            {"settings": []},
        )
        self.assertEqual(response.status_code, 400)

    def test_reinstall_is_idempotent_until_acknowledged(self):
        first = self.client.post(self.reinstall_path())
        second = self.client.post(self.reinstall_path())
        pending = self.client.get(self.reinstall_path())

        self.assertEqual(first.status_code, 202)
        self.assertEqual(first.headers["Cache-Control"], "no-store")
        self.assertEqual(second.status_code, 202)
        self.assertEqual(second.json()["token"], first.json()["token"])
        self.assertEqual(pending.status_code, 200)
        self.assertEqual(pending.json()["token"], first.json()["token"])
        self.assertEqual(Reinstall.objects.count(), 1)

    def test_reinstall_request_recovers_processing_work(self):
        processing = Instruction.objects.create(
            bid=self.BID,
            action="javascript",
            status=Instruction.Status.PROCESSING,
        )
        pending = Instruction.objects.create(bid=self.BID, action="list")
        requested = self.client.post(self.reinstall_path())
        token = requested.json()["token"]

        processing.refresh_from_db()
        pending.refresh_from_db()
        self.assertEqual(processing.status, Instruction.Status.FAILED)
        self.assertEqual(processing.error, EXTENSION_REINSTALL_ERROR)
        self.assertEqual(pending.status, Instruction.Status.PENDING)

        mismatch = self.post_json(
            self.reinstall_path("acknowledge/"),
            {"token": "00000000-0000-4000-8000-000000000000"},
        )
        self.assertEqual(mismatch.status_code, 409)
        self.assertTrue(Reinstall.objects.exists())

        command = self.client.get(self.instruction_path("next/?limit=4"))
        self.assertEqual(command.status_code, 200)
        self.assertEqual(command.headers["Cache-Control"], "no-store")
        self.assertEqual(
            command.json(),
            [{"action": "reinstall", "payload": {"token": token}}],
        )

        acknowledged = self.post_json(
            self.reinstall_path("acknowledge/"),
            {"token": token},
        )

        self.assertEqual(acknowledged.status_code, 204)
        processing.refresh_from_db()
        pending.refresh_from_db()
        self.assertEqual(processing.status, Instruction.Status.FAILED)
        self.assertEqual(processing.error, EXTENSION_REINSTALL_ERROR)
        self.assertEqual(pending.status, Instruction.Status.PENDING)
        self.assertFalse(Reinstall.objects.exists())
        self.assertEqual(self.client.get(self.reinstall_path()).status_code, 204)

        reclaimed = self.client.get(self.instruction_path("next/"))
        self.assertEqual(reclaimed.status_code, 200)
        self.assertEqual(reclaimed.json()[0]["id"], pending.id)
        pending.refresh_from_db()
        self.assertEqual(pending.status, Instruction.Status.PROCESSING)

        repeated = self.post_json(
            self.reinstall_path("acknowledge/"),
            {"token": token},
        )
        self.assertEqual(repeated.status_code, 204)


class StorageBackendTests(TestCase):
    def test_unconfigured_backend_is_none(self):
        from .storage import create_storage_backend

        self.assertIsNone(create_storage_backend("chipf", {}))
        self.assertIsNone(create_storage_backend("chipf", {"chipf": {}}))
        self.assertIsNone(
            create_storage_backend(
                "chipf", {"chipf": {"endpoint": "https://chipf.test"}}
            )
        )
        self.assertIsNone(
            create_storage_backend("chipf", {"chipf": {"api_key": "secret"}})
        )
        self.assertIsNone(create_storage_backend("chipf", None))

    def test_unknown_provider_is_a_configuration_error(self):
        from .storage import StorageError, create_storage_backend

        with self.assertRaisesRegex(StorageError, "unknown storage provider"):
            create_storage_backend("s3", {"s3": {"endpoint": "x", "api_key": "y"}})

    def test_configured_chipf_backend_is_returned(self):
        from .storage import ChipfStorageBackend, create_storage_backend

        backend = create_storage_backend(
            "chipf",
            {"chipf": {"endpoint": "https://chipf.test", "api_key": "secret"}},
        )
        assert isinstance(backend, ChipfStorageBackend)
        self.assertEqual(backend.endpoint, "https://chipf.test")
        self.assertEqual(backend.api_key, "secret")

    def test_upload_file_returns_the_resolved_url(self):
        from .storage import ChipfStorageBackend

        backend = ChipfStorageBackend("https://chipf.test", "secret")
        response = SimpleNamespace(
            status_code=201,
            content=(
                b'{"files":[{"file_id":"abc","url":"/api/files/abc",'
                b'"content_type":"image/png"}]}'
            ),
        )

        with patch("api.storage.httpx.post", return_value=response) as post:
            url = backend.upload_file(b"png", "screenshot-12.png", "image/png")

        self.assertEqual(url, "https://chipf.test/api/files/abc")
        post.assert_called_once_with(
            "https://chipf.test/api/files/upload",
            files={
                "file": ("screenshot-12.png", b"png", "image/png"),
            },
            headers={"X-API-Key": "secret"},
            timeout=30.0,
        )

    def test_upload_file_rejects_a_non_201_response(self):
        from .storage import ChipfStorageBackend, StorageHTTPError

        backend = ChipfStorageBackend("https://chipf.test", "secret")
        response = SimpleNamespace(
            status_code=401,
            content=b'{"error":"unauthorized"}',
        )

        with (
            patch("api.storage.httpx.post", return_value=response),
            self.assertRaisesRegex(StorageHTTPError, "unauthorized"),
        ):
            backend.upload_file(b"png", "screenshot-12.png", "image/png")

    def test_upload_file_wraps_connection_failures(self):
        from .storage import ChipfStorageBackend, StorageConnectionError

        backend = ChipfStorageBackend("https://chipf.test", "secret")

        with (
            patch(
                "api.storage.httpx.post",
                side_effect=httpx.ConnectError("refused"),
            ),
            self.assertRaisesRegex(StorageConnectionError, "refused"),
        ):
            backend.upload_file(b"png", "screenshot-12.png", "image/png")

    def test_upload_file_rejects_invalid_responses(self):
        from .storage import ChipfStorageBackend, StorageProtocolError

        backend = ChipfStorageBackend("https://chipf.test", "secret")
        response = SimpleNamespace(status_code=201, content=b"not json")

        with (
            patch("api.storage.httpx.post", return_value=response),
            self.assertRaises(StorageProtocolError),
        ):
            backend.upload_file(b"png", "screenshot-12.png", "image/png")
