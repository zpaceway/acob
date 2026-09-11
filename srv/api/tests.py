from __future__ import annotations

import base64
import json
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING, cast
from unittest.mock import patch

from django.test import TestCase, override_settings

if TYPE_CHECKING:
    from django.test.client import _MonkeyPatchedWSGIResponse

from .models import Instruction, Reinstall
from .recovery import EXTENSION_REINSTALL_ERROR
from .storage import StorageError, store_media


class InstructionApiTests(TestCase):
    def instruction_path(self, suffix: str = "") -> str:
        return f"/api/instructions/{suffix}"

    def batch_path(self, suffix: str = "") -> str:
        return f"/api/instructions/batch/{suffix}"

    def post_json(self, path: str, data: object) -> _MonkeyPatchedWSGIResponse:
        return self.client.post(
            path,
            data=json.dumps(data),
            content_type="application/json",
        )

    def post_result(
        self,
        instruction_id: int,
        data: object,
    ) -> _MonkeyPatchedWSGIResponse:
        return self.post_json(
            self.instruction_path(f"{instruction_id}/result/"),
            data,
        )

    def reinstall_path(self, suffix: str = "") -> str:
        return f"/api/reinstall/{suffix}"

    def test_instruction_flow(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "list"},
        )

        self.assertEqual(created.status_code, 201)
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
        self.assertTrue(Instruction.objects.filter(id=instruction_id).exists())
        reread = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(reread.status_code, 200)
        self.assertEqual(reread.json()["result"], [])
        empty_queue = self.client.get(self.instruction_path("next/"))
        self.assertEqual(empty_queue.status_code, 204)
        self.assertEqual(empty_queue.headers["Cache-Control"], "no-store")

    def test_pending_and_processing_reads_are_not_consumed(self) -> None:
        instruction = Instruction.objects.create(action="list")

        pending = self.client.get(self.instruction_path(f"{instruction.id}/"))
        processing = self.client.get(self.instruction_path("next/")).json()[0]

        self.assertEqual(pending.json()["status"], "pending")
        self.assertEqual(processing["status"], "processing")
        self.assertTrue(Instruction.objects.filter(id=instruction.id).exists())

    def test_claims_up_to_the_requested_instruction_limit(self) -> None:
        instructions = [Instruction.objects.create(action="list") for _ in range(6)]

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

    def test_pending_reinstall_blocks_instruction_claims(self) -> None:
        instruction = Instruction.objects.create(action="list")
        reinstall_request = Reinstall.objects.create()

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

    def test_rejects_invalid_instruction_claim_limits(self) -> None:
        for limit in ("0", "21", "invalid"):
            with self.subTest(limit=limit):
                response = self.client.get(
                    self.instruction_path(f"next/?limit={limit}")
                )

                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"], "Invalid request")
                self.assertEqual(response.json()["details"][0]["field"], "limit")

    def test_batch_creates_one_instruction_with_all_actions(self) -> None:
        response = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [
                    {"action": "list"},
                    {"action": "navigate", "url": "https://example.com"},
                    {"action": "scroll", "tid": 12, "y": 500},
                    {"action": "click", "tid": 12, "selector": "button"},
                    {"action": "keyboard", "tid": 12, "text": "ACOB"},
                ],
            },
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["action"], "batch")
        self.assertEqual(
            response.json()["payload"]["actions"],
            [
                {"action": "list"},
                {"action": "navigate", "url": "https://example.com"},
                {"action": "scroll", "tid": 12, "y": 500.0},
                {"action": "click", "tid": 12, "selector": "button"},
                {
                    "action": "keyboard",
                    "tid": 12,
                    "text": "ACOB",
                    "modifiers": [],
                },
            ],
        )
        self.assertNotIn("tid", response.json()["payload"]["actions"][1])
        self.assertNotIn("key", response.json()["payload"]["actions"][4])
        self.assertEqual(Instruction.objects.count(), 1)
        instruction = Instruction.objects.get()
        self.assertEqual(instruction.action, Instruction.Action.BATCH)

    def test_batch_rejects_empty_or_oversized_action_lists(self) -> None:
        empty = self.post_json(
            self.batch_path(),
            {"action": "batch", "actions": []},
        )
        oversized = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [{"action": "list"} for _ in range(21)],
            },
        )

        self.assertEqual(empty.status_code, 400)
        self.assertEqual(empty.json()["details"][0]["field"], "actions")
        self.assertEqual(oversized.status_code, 400)
        self.assertEqual(oversized.json()["details"][0]["field"], "actions")

    def test_batch_rejects_invalid_sub_actions(self) -> None:
        missing_tid = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [
                    {"action": "list"},
                    {"action": "click", "selector": "button"},
                ],
            },
        )
        unknown_action = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [{"action": "unknown"}],
            },
        )

        self.assertEqual(missing_tid.status_code, 400)
        self.assertEqual(
            missing_tid.json()["details"][0]["field"],
            "actions.1.click.tid",
        )
        self.assertEqual(unknown_action.status_code, 400)

    def test_single_instruction_route_rejects_batch(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {
                "action": "batch",
                "actions": [{"action": "list"}],
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(
            response.json()["details"][0]["type"],
            "union_tag_invalid",
        )

    def test_batch_claims_and_completes_with_per_action_results(self) -> None:
        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [
                    {"action": "list"},
                    {"action": "scroll", "tid": 12, "y": 500},
                ],
            },
        )
        instruction_id = created.json()["id"]

        claimed = self.client.get(self.instruction_path("next/"))
        self.assertEqual(claimed.status_code, 200)
        self.assertEqual(len(claimed.json()), 1)
        self.assertEqual(claimed.json()[0]["action"], "batch")
        self.assertEqual(claimed.json()[0]["status"], "processing")

        completed = self.post_result(
            instruction_id,
            {
                "result": [
                    {"result": []},
                    {"result": {"scrolled": True, "y": 500}},
                ]
            },
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["status"], "completed")
        self.assertEqual(
            completed.json()["result"],
            [
                {"result": []},
                {"result": {"scrolled": True, "y": 500}},
            ],
        )

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["result"], completed.json()["result"])
        self.assertTrue(Instruction.objects.filter(id=instruction_id).exists())
        reread = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(reread.status_code, 200)
        self.assertEqual(reread.json()["result"], completed.json()["result"])

    def test_batch_reports_per_action_errors_without_stopping(self) -> None:
        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [
                    {"action": "list"},
                    {"action": "close", "tid": 12},
                ],
            },
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        completed = self.post_result(
            instruction_id,
            {
                "result": [
                    {"error": "Chromium did not return a tab"},
                    {"result": {"closed": True, "tab": {}}},
                ]
            },
        )

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["status"], "completed")
        self.assertEqual(
            completed.json()["result"],
            [
                {"error": "Chromium did not return a tab"},
                {"result": {"closed": True, "tab": {}}},
            ],
        )

    def test_batch_screenshot_entries_are_stored_locally(self) -> None:
        image = b"\x89PNG\r\n\x1a\nACOB"
        encoded = base64.b64encode(image).decode()
        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [
                    {"action": "list"},
                    {"action": "screenshot", "tid": 12, "full_page": True},
                ],
            },
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            tempfile.TemporaryDirectory() as media_dir,
            override_settings(
                MEDIA_ROOT=Path(media_dir),
                ACOB_SRV_PUBLIC_URL="http://127.0.0.1:58466",
            ),
        ):
            completed = self.post_result(
                instruction_id,
                {
                    "result": [
                        {"result": []},
                        {"result": {"data": encoded}},
                    ]
                },
            )
            stored = list(Path(media_dir).glob("screenshot-12-*.png"))
            stored_bytes = stored[0].read_bytes() if stored else b""
            stored_name = stored[0].name if stored else ""

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored_bytes, image)
        self.assertEqual(
            completed.json()["result"],
            [
                {"result": []},
                {
                    "result": {
                        "url": f"http://127.0.0.1:58466/api/media/{stored_name}",
                        "content_type": "image/png",
                        "full_page": True,
                    }
                },
            ],
        )

    def test_batch_capture_hosting_failure_becomes_an_entry_error(self) -> None:
        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [
                    {"action": "screenshot", "tid": 12},
                ],
            },
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with patch(
            "api.views.store_media",
            side_effect=StorageError("disk is full"),
        ):
            completed = self.post_result(
                instruction_id,
                {"result": [{"result": {"data": base64.b64encode(b"image").decode()}}]},
            )

        self.assertEqual(completed.status_code, 200)
        response = completed.json()
        self.assertEqual(response["status"], "completed")
        entry = response["result"][0]
        self.assertIn("error", entry)
        self.assertIn("Could not host the screenshot", entry["error"])
        self.assertIn("disk is full", entry["error"])

    def test_batch_record_entries_are_validated(self) -> None:
        recording = b"0\x9awEBMACOB"
        encoded = base64.b64encode(recording).decode()
        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [
                    {"action": "record", "method": "start", "tid": 12},
                    {"action": "record", "method": "stop", "tid": 12},
                ],
            },
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            tempfile.TemporaryDirectory() as media_dir,
            override_settings(MEDIA_ROOT=Path(media_dir)),
        ):
            completed = self.post_result(
                instruction_id,
                {
                    "result": [
                        {"result": {"started": True}},
                        {
                            "result": {
                                "data": encoded,
                                "content_type": "video/webm",
                                "duration": 5.0,
                                "stopped_reason": "user",
                                "message": "Recording stopped by user request",
                            }
                        },
                    ]
                },
            )
            stored = list(Path(media_dir).glob("recording-12-*.webm"))
            stored_bytes = stored[0].read_bytes() if stored else b""
            stored_name = stored[0].name if stored else ""

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored_bytes, recording)
        self.assertEqual(
            completed.json()["result"],
            [
                {"result": {"started": True}},
                {
                    "result": {
                        "url": f"http://testserver/api/media/{stored_name}",
                        "content_type": "video/webm",
                        "duration": 5.0,
                        "stopped_reason": "user",
                        "message": "Recording stopped by user request",
                    }
                },
            ],
        )

    def test_batch_rejects_malformed_entries(self) -> None:
        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [{"action": "screenshot", "tid": 12}],
            },
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        bad_base64 = self.post_result(
            instruction_id,
            {"result": [{"result": {"data": "not base64!"}}]},
        )
        self.assertEqual(bad_base64.status_code, 400)
        self.assertEqual(bad_base64.json()["error"], "Invalid screenshot data")

        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [{"action": "record", "method": "start", "tid": 12}],
            },
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))
        invalid_result = self.post_result(
            instruction_id,
            {"result": [{"result": {"started": "yes"}}]},
        )
        self.assertEqual(invalid_result.status_code, 400)

        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [
                    {"action": "list"},
                    {"action": "list"},
                ],
            },
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))
        wrong_count = self.post_result(
            instruction_id,
            {"result": [{"result": []}]},
        )
        self.assertEqual(wrong_count.status_code, 400)
        self.assertEqual(
            wrong_count.json()["error"],
            "Batch result must contain one entry per batch action",
        )
        self.assertFalse(
            Instruction.objects.filter(
                id=instruction_id,
                status=Instruction.Status.COMPLETED,
            ).exists()
        )

    def test_batch_rejects_entries_with_result_and_error(self) -> None:
        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [{"action": "list"}],
            },
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        response = self.post_result(
            instruction_id,
            {"result": [{"result": [], "error": "Browser is unavailable"}]},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")

    def test_failed_instruction(self) -> None:
        instruction = Instruction.objects.create(action="list")
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
        self.assertTrue(Instruction.objects.filter(id=instruction.id).exists())
        reread = self.client.get(self.instruction_path(f"{instruction.id}/"))
        self.assertEqual(reread.status_code, 200)
        self.assertEqual(reread.json()["error"], "Browser is unavailable")

    def test_rejects_invalid_instruction(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "javascript", "tid": 12, "script": ""},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "javascript.script")

    def test_rejects_unknown_action(self) -> None:
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

    def test_does_not_return_processing_instruction(self) -> None:
        Instruction.objects.create(
            action="list",
            status=Instruction.Status.PROCESSING,
        )

        response = self.client.get(self.instruction_path("next/"))

        self.assertEqual(response.status_code, 204)

    def test_accepts_root_tab_actions(self) -> None:
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

    def test_rejects_legacy_grouped_tabs_action(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "list"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["type"], "union_tag_invalid")

    def test_targeted_tab_actions_require_tid(self) -> None:
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

    def test_list_rejects_tab_fields(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "list", "tid": 12},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "list.tid")
        self.assertEqual(response.json()["details"][0]["type"], "extra_forbidden")

    def test_navigate_requires_url(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "navigate"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "navigate.url")

    def test_navigate_rejects_empty_url(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "navigate", "url": "  "},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "navigate.url")

    def test_scroll_requires_a_finite_number(self) -> None:
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

    def test_rejects_result_with_error(self) -> None:
        instruction = Instruction.objects.create(action="list")
        self.client.get(self.instruction_path("next/"))

        response = self.post_result(
            instruction.id,
            {"result": [], "error": "Browser is unavailable"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "body")

    def test_rejects_non_finite_scroll_result(self) -> None:
        instruction = Instruction.objects.create(
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

    def test_accepts_javascript_instruction(self) -> None:
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

    def test_javascript_requires_target_tab(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "javascript", "script": "document.title"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "javascript.tid")

    def test_accepts_click_instruction(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "click", "tid": 12, "selector": "button[type=submit]"},
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["action"], "click")
        self.assertEqual(response.json()["payload"]["tid"], 12)
        self.assertEqual(response.json()["payload"]["selector"], "button[type=submit]")

    def test_click_requires_target_tab(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "click", "selector": "button"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "click.tid")

    def test_click_requires_non_empty_selector(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "click", "tid": 12, "selector": "  "},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "click.selector")

    def test_accepts_keyboard_text_and_key_instructions(self) -> None:
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

    def test_keyboard_requires_exactly_one_input(self) -> None:
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

    def test_keyboard_rejects_invalid_modifiers_and_keys(self) -> None:
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

    def test_accepts_screenshot_instruction(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "screenshot", "tid": 12, "full_page": True},
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["payload"], {"tid": 12, "full_page": True})

    def test_screenshot_requires_target_tab(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "screenshot"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "screenshot.tid")

    def test_screenshot_result_is_stored_locally(self) -> None:
        image = b"\x89PNG\r\n\x1a\nACOB"
        encoded = base64.b64encode(image).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "screenshot", "tid": 12, "full_page": True},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            tempfile.TemporaryDirectory() as media_dir,
            override_settings(MEDIA_ROOT=Path(media_dir)),
        ):
            completed = self.post_result(
                instruction_id,
                {"result": {"data": encoded}},
            )
            stored = list(Path(media_dir).glob("screenshot-12-*.png"))
            stored_bytes = stored[0].read_bytes() if stored else b""
            stored_name = stored[0].name if stored else ""

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored_bytes, image)
        result = completed.json()["result"]
        self.assertEqual(
            result,
            {
                "url": f"http://testserver/api/media/{stored_name}",
                "content_type": "image/png",
                "full_page": True,
            },
        )

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["result"], result)
        self.assertTrue(Instruction.objects.filter(id=instruction_id).exists())
        self.assertEqual(
            self.client.get(self.instruction_path(f"{instruction_id}/")).json()[
                "result"
            ],
            result,
        )

    def test_screenshot_fails_when_media_cannot_be_stored(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "screenshot", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with patch(
            "api.views.store_media",
            side_effect=StorageError("disk is full"),
        ):
            completed = self.post_result(
                instruction_id,
                {"result": {"data": base64.b64encode(b"image").decode()}},
            )

        self.assertEqual(completed.status_code, 200)
        response = completed.json()
        self.assertEqual(response["status"], "failed")
        self.assertIn("Could not host the screenshot", response["error"])
        self.assertIn("disk is full", response["error"])

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["error"], response["error"])
        self.assertTrue(Instruction.objects.filter(id=instruction_id).exists())
        self.assertEqual(
            self.client.get(self.instruction_path(f"{instruction_id}/")).json()[
                "error"
            ],
            response["error"],
        )

    def test_rejects_invalid_screenshot_result(self) -> None:
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

    def test_accepts_record_instructions(self) -> None:
        started = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "start", "tid": 12},
        )
        stopped = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "stop", "tid": 12},
        )

        self.assertEqual(started.status_code, 201)
        self.assertEqual(
            started.json()["payload"],
            {"method": "start", "tid": 12, "full_page": False},
        )
        self.assertEqual(stopped.status_code, 201)
        self.assertEqual(
            stopped.json()["payload"],
            {"method": "stop", "tid": 12, "full_page": False},
        )

    def test_record_accepts_full_page_flag(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "start", "tid": 12, "full_page": True},
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            response.json()["payload"],
            {"method": "start", "tid": 12, "full_page": True},
        )

        invalid = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "start", "tid": 12, "full_page": "yes"},
        )
        self.assertEqual(invalid.status_code, 400)

    def test_record_instructions_require_valid_arguments(self) -> None:
        missing_method = self.post_json(
            self.instruction_path(),
            {"action": "record", "tid": 12},
        )
        missing_tid = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "start"},
        )
        invalid_tid = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "stop", "tid": 0},
        )
        stop_with_full_page = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "stop", "tid": 12, "full_page": True},
        )

        self.assertEqual(missing_method.status_code, 400)
        self.assertEqual(missing_tid.status_code, 400)
        self.assertEqual(invalid_tid.status_code, 400)
        self.assertEqual(stop_with_full_page.status_code, 400)

    def test_record_start_result_validated(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "start", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        completed = self.post_result(
            instruction_id,
            {"result": {"started": True}},
        )

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(
            completed.json()["result"],
            {"started": True},
        )

        invalid = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "start", "tid": 12},
        )
        invalid_id = invalid.json()["id"]
        self.client.get(self.instruction_path("next/"))
        rejected = self.post_result(
            invalid_id,
            {"result": {"started": "yes"}},
        )
        self.assertEqual(rejected.status_code, 400)

    def test_record_stop_result_stored_locally(self) -> None:
        recording = b"0\x9awEBMACOB"
        encoded = base64.b64encode(recording).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "stop", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            tempfile.TemporaryDirectory() as media_dir,
            override_settings(MEDIA_ROOT=Path(media_dir)),
        ):
            completed = self.post_result(
                instruction_id,
                {
                    "result": {
                        "data": encoded,
                        "content_type": "video/webm",
                        "duration": 5.0,
                        "stopped_reason": "max_duration",
                        "message": (
                            "Recording stopped because the maximum duration was reached"
                        ),
                    }
                },
            )
            stored = list(Path(media_dir).glob("recording-12-*.webm"))
            stored_bytes = stored[0].read_bytes() if stored else b""
            stored_name = stored[0].name if stored else ""

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored_bytes, recording)
        result = completed.json()["result"]
        self.assertEqual(
            result,
            {
                "url": f"http://testserver/api/media/{stored_name}",
                "content_type": "video/webm",
                "duration": 5.0,
                "stopped_reason": "max_duration",
                "message": (
                    "Recording stopped because the maximum duration was reached"
                ),
            },
        )

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["result"], result)
        self.assertTrue(Instruction.objects.filter(id=instruction_id).exists())
        self.assertEqual(
            self.client.get(self.instruction_path(f"{instruction_id}/")).json()[
                "result"
            ],
            result,
        )

    def test_record_stop_fails_when_media_unstorable(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "stop", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with patch(
            "api.views.store_media",
            side_effect=StorageError("disk is full"),
        ):
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
        self.assertIn("disk is full", response["error"])

    def test_rejects_invalid_record_stop_upload(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "stop", "tid": 12},
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
            {"action": "record", "method": "stop", "tid": 12},
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

    def test_record_stop_accepts_mp4(self) -> None:
        recording = b"0\x9awMP4ACOB"
        encoded = base64.b64encode(recording).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "stop", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            tempfile.TemporaryDirectory() as media_dir,
            override_settings(MEDIA_ROOT=Path(media_dir)),
        ):
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
            stored = list(Path(media_dir).glob("recording-12-*.mp4"))
            stored_bytes = stored[0].read_bytes() if stored else b""
            stored_name = stored[0].name if stored else ""

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored_bytes, recording)
        result = completed.json()["result"]
        self.assertEqual(result["content_type"], "video/mp4")
        self.assertEqual(result["duration"], 5.0)
        self.assertEqual(result["stopped_reason"], "user")
        self.assertEqual(
            result["url"],
            f"http://testserver/api/media/{stored_name}",
        )

    def test_rejects_unknown_record_content_type(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "record", "method": "stop", "tid": 12},
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

    def test_accepts_proxy_set_and_unset_instructions(self) -> None:
        set_response = self.post_json(
            self.instruction_path(),
            {"action": "proxy", "method": "set", "proxy": "http://127.0.0.1:8080"},
        )
        unset_response = self.post_json(
            self.instruction_path(),
            {"action": "proxy", "method": "unset"},
        )

        self.assertEqual(set_response.status_code, 201)
        self.assertEqual(
            set_response.json()["payload"],
            {"method": "set", "proxy": "http://127.0.0.1:8080"},
        )
        self.assertEqual(unset_response.status_code, 201)
        self.assertEqual(unset_response.json()["payload"], {"method": "unset"})

    def test_proxy_instructions_require_valid_arguments(self) -> None:
        missing_proxy = self.post_json(
            self.instruction_path(),
            {"action": "proxy", "method": "set"},
        )
        proxy_on_unset = self.post_json(
            self.instruction_path(),
            {"action": "proxy", "method": "unset", "proxy": "http://127.0.0.1:8080"},
        )
        bad_scheme = self.post_json(
            self.instruction_path(),
            {"action": "proxy", "method": "set", "proxy": "ftp://127.0.0.1:21"},
        )
        missing_port = self.post_json(
            self.instruction_path(),
            {"action": "proxy", "method": "set", "proxy": "http://127.0.0.1"},
        )
        missing_method = self.post_json(
            self.instruction_path(),
            {"action": "proxy", "proxy": "http://127.0.0.1:8080"},
        )

        self.assertEqual(missing_proxy.status_code, 400)
        self.assertEqual(proxy_on_unset.status_code, 400)
        self.assertEqual(bad_scheme.status_code, 400)
        self.assertEqual(missing_port.status_code, 400)
        self.assertEqual(missing_method.status_code, 400)

    def test_proxy_accepts_all_schemes_and_auth(self) -> None:
        for proxy in (
            "http://127.0.0.1:8080",
            "https://proxy.example:8443",
            "socks5://127.0.0.1:1080",
            "http://user:pass@127.0.0.1:8080",
            "socks5://user@127.0.0.1:1080",
        ):
            response = self.post_json(
                self.instruction_path(),
                {"action": "proxy", "method": "set", "proxy": proxy},
            )
            self.assertEqual(response.status_code, 201, proxy)

    def test_proxy_result_is_validated(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "proxy", "method": "set", "proxy": "http://127.0.0.1:8080"},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        completed = self.post_result(
            instruction_id,
            {
                "result": {
                    "proxied": True,
                    "scheme": "http",
                    "host": "127.0.0.1",
                    "port": 8080,
                    "authenticated": False,
                }
            },
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(
            completed.json()["result"],
            {
                "proxied": True,
                "scheme": "http",
                "host": "127.0.0.1",
                "port": 8080,
                "authenticated": False,
            },
        )

        created = self.post_json(
            self.instruction_path(),
            {"action": "proxy", "method": "unset"},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))
        completed = self.post_result(
            instruction_id,
            {"result": {"proxied": False}},
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["result"], {"proxied": False})

        created = self.post_json(
            self.instruction_path(),
            {"action": "proxy", "method": "set", "proxy": "http://127.0.0.1:8080"},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))
        rejected = self.post_result(
            instruction_id,
            {"result": {"proxied": True, "scheme": "ftp", "host": "x", "port": 1}},
        )
        self.assertEqual(rejected.status_code, 400)

    def test_accepts_console_instructions(self) -> None:
        started = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "start", "tid": 12},
        )
        captured = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "capture", "tid": 12},
        )
        stopped = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "stop", "tid": 12},
        )

        self.assertEqual(started.status_code, 201)
        self.assertEqual(started.json()["payload"], {"method": "start", "tid": 12})
        self.assertEqual(captured.status_code, 201)
        self.assertEqual(captured.json()["payload"], {"method": "capture", "tid": 12})
        self.assertEqual(stopped.status_code, 201)
        self.assertEqual(stopped.json()["payload"], {"method": "stop", "tid": 12})

    def test_accepts_cleanup_instruction(self) -> None:
        response = self.post_json(
            self.instruction_path(),
            {"action": "cleanup"},
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["action"], "cleanup")
        self.assertEqual(response.json()["payload"], {})

    def test_cleanup_rejects_payload_fields(self) -> None:
        with_confirm = self.post_json(
            self.instruction_path(),
            {"action": "cleanup", "confirm": True},
        )
        with_tid = self.post_json(
            self.instruction_path(),
            {"action": "cleanup", "tid": 12},
        )

        self.assertEqual(with_confirm.status_code, 400)
        self.assertEqual(with_tid.status_code, 400)

    def test_cleanup_result_is_validated(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "cleanup"},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        completed = self.post_result(
            instruction_id,
            {"result": {"cleaned": True}},
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["result"], {"cleaned": True})

        created = self.post_json(
            self.instruction_path(),
            {"action": "cleanup"},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))
        rejected = self.post_result(
            instruction_id,
            {"result": {"cleaned": False}},
        )
        self.assertEqual(rejected.status_code, 400)

    def test_console_instructions_require_valid_arguments(self) -> None:
        missing_method = self.post_json(
            self.instruction_path(),
            {"action": "console", "tid": 12},
        )
        missing_tid = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "start"},
        )
        invalid_tid = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "capture", "tid": 0},
        )
        bad_method = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "begin", "tid": 12},
        )
        extra_field = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "start", "tid": 12, "full_page": True},
        )

        self.assertEqual(missing_method.status_code, 400)
        self.assertEqual(missing_tid.status_code, 400)
        self.assertEqual(invalid_tid.status_code, 400)
        self.assertEqual(bad_method.status_code, 400)
        self.assertEqual(extra_field.status_code, 400)

    def test_console_start_result_validated(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "start", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        completed = self.post_result(
            instruction_id,
            {"result": {"started": True}},
        )

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["result"], {"started": True})

        invalid = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "start", "tid": 12},
        )
        invalid_id = invalid.json()["id"]
        self.client.get(self.instruction_path("next/"))
        rejected = self.post_result(
            invalid_id,
            {"result": {"started": "yes"}},
        )
        self.assertEqual(rejected.status_code, 400)

    def test_console_capture_result_stored_locally(self) -> None:
        document = b'[{"type":"log","text":"hello"}]'
        encoded = base64.b64encode(document).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "capture", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            tempfile.TemporaryDirectory() as media_dir,
            override_settings(MEDIA_ROOT=Path(media_dir)),
        ):
            completed = self.post_result(
                instruction_id,
                {
                    "result": {
                        "data": encoded,
                        "content_type": "application/json",
                        "entries": 1,
                        "size_bytes": len(document),
                        "truncated": False,
                    }
                },
            )
            stored = list(Path(media_dir).glob("console-12-*.json"))
            stored_bytes = stored[0].read_bytes() if stored else b""
            stored_name = stored[0].name if stored else ""

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored_bytes, document)
        result = completed.json()["result"]
        self.assertEqual(
            result,
            {
                "url": f"http://testserver/api/media/{stored_name}",
                "content_type": "application/json",
                "entries": 1,
                "size_bytes": len(document),
                "truncated": False,
            },
        )

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["result"], result)
        self.assertTrue(Instruction.objects.filter(id=instruction_id).exists())
        self.assertEqual(
            self.client.get(self.instruction_path(f"{instruction_id}/")).json()[
                "result"
            ],
            result,
        )

    def test_console_stop_result_stored_locally(self) -> None:
        document = b'[{"type":"error","text":"boom"}]'
        encoded = base64.b64encode(document).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "stop", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            tempfile.TemporaryDirectory() as media_dir,
            override_settings(MEDIA_ROOT=Path(media_dir)),
        ):
            completed = self.post_result(
                instruction_id,
                {
                    "result": {
                        "data": encoded,
                        "content_type": "application/json",
                        "entries": 1,
                        "size_bytes": len(document),
                        "truncated": True,
                    }
                },
            )
            stored = list(Path(media_dir).glob("console-12-*.json"))
            stored_bytes = stored[0].read_bytes() if stored else b""
            stored_name = stored[0].name if stored else ""

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored_bytes, document)
        result = completed.json()["result"]
        self.assertEqual(
            result,
            {
                "url": f"http://testserver/api/media/{stored_name}",
                "content_type": "application/json",
                "entries": 1,
                "size_bytes": len(document),
                "truncated": True,
            },
        )

    def test_console_capture_fails_when_media_unstorable(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "capture", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with patch(
            "api.views.store_media",
            side_effect=StorageError("disk is full"),
        ):
            completed = self.post_result(
                instruction_id,
                {
                    "result": {
                        "data": base64.b64encode(b"[]").decode(),
                        "content_type": "application/json",
                        "entries": 0,
                        "size_bytes": 2,
                        "truncated": False,
                    }
                },
            )

        self.assertEqual(completed.status_code, 200)
        response = completed.json()
        self.assertEqual(response["status"], "failed")
        self.assertIn("Could not host the console capture", response["error"])
        self.assertIn("disk is full", response["error"])

    def test_rejects_invalid_console_capture_upload(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "capture", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        bad_base64 = self.post_result(
            instruction_id,
            {
                "result": {
                    "data": "not base64!",
                    "content_type": "application/json",
                    "entries": 0,
                    "size_bytes": 0,
                    "truncated": False,
                }
            },
        )
        self.assertEqual(bad_base64.status_code, 400)
        self.assertEqual(bad_base64.json()["error"], "Invalid console data")

        created = self.post_json(
            self.instruction_path(),
            {"action": "console", "method": "stop", "tid": 12},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))
        bad_type = self.post_result(
            instruction_id,
            {
                "result": {
                    "data": base64.b64encode(b"[]").decode(),
                    "content_type": "text/plain",
                    "entries": 0,
                    "size_bytes": 2,
                    "truncated": False,
                }
            },
        )
        self.assertEqual(bad_type.status_code, 400)

    def test_batch_console_entries_are_validated(self) -> None:
        document = b'[{"type":"log","text":"hello"}]'
        encoded = base64.b64encode(document).decode()
        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [
                    {"action": "console", "method": "start", "tid": 12},
                    {"action": "console", "method": "capture", "tid": 12},
                ],
            },
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        with (
            tempfile.TemporaryDirectory() as media_dir,
            override_settings(MEDIA_ROOT=Path(media_dir)),
        ):
            completed = self.post_result(
                instruction_id,
                {
                    "result": [
                        {"result": {"started": True}},
                        {
                            "result": {
                                "data": encoded,
                                "content_type": "application/json",
                                "entries": 1,
                                "size_bytes": len(document),
                                "truncated": False,
                            }
                        },
                    ]
                },
            )
            stored = list(Path(media_dir).glob("console-12-*.json"))
            stored_bytes = stored[0].read_bytes() if stored else b""
            stored_name = stored[0].name if stored else ""

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored_bytes, document)
        self.assertEqual(
            completed.json()["result"],
            [
                {"result": {"started": True}},
                {
                    "result": {
                        "url": f"http://testserver/api/media/{stored_name}",
                        "content_type": "application/json",
                        "entries": 1,
                        "size_bytes": len(document),
                        "truncated": False,
                    }
                },
            ],
        )

    def test_reinstall_is_idempotent_until_acknowledged(self) -> None:
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

    def test_reinstall_request_recovers_processing_work(self) -> None:
        processing = Instruction.objects.create(
            action="javascript",
            status=Instruction.Status.PROCESSING,
        )
        pending = Instruction.objects.create(action="list")
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


class BidTargetingTests(TestCase):
    BID_A = "a" * 32
    BID_B = "b" * 32
    BID_C = "c" * 32

    def instruction_path(self, suffix: str = "") -> str:
        return f"/api/instructions/{suffix}"

    def batch_path(self, suffix: str = "") -> str:
        return f"/api/instructions/batch/{suffix}"

    def post_json(self, path: str, data: object) -> _MonkeyPatchedWSGIResponse:
        return self.client.post(
            path,
            data=json.dumps(data),
            content_type="application/json",
        )

    def post_result(
        self, instruction_id: int, data: object, query: str = ""
    ) -> _MonkeyPatchedWSGIResponse:
        return self.post_json(
            self.instruction_path(f"{instruction_id}/result/{query}"),
            data,
        )

    def test_create_persists_bid_and_response_always_has_bid(self) -> None:
        untargeted = self.post_json(self.instruction_path(), {"action": "list"})
        self.assertEqual(untargeted.status_code, 201)
        self.assertIn("bid", untargeted.json())
        self.assertIsNone(untargeted.json()["bid"])
        self.assertEqual(untargeted.json()["payload"], {})

        targeted = self.post_json(
            self.instruction_path(),
            {"action": "list", "bid": self.BID_A},
        )
        self.assertEqual(targeted.status_code, 201)
        self.assertEqual(targeted.json()["bid"], self.BID_A)
        self.assertEqual(targeted.json()["payload"], {})
        self.assertNotIn("bid", targeted.json()["payload"])

        untargeted_row = Instruction.objects.get(id=untargeted.json()["id"])
        targeted_row = Instruction.objects.get(id=targeted.json()["id"])
        self.assertIsNone(untargeted_row.bid)
        self.assertEqual(targeted_row.bid, self.BID_A)

    def test_rejects_invalid_bid(self) -> None:
        for bad in ("ABC", "z" * 32, "A" * 32, "short", "a" * 31 + "-"):
            with self.subTest(bad=bad):
                response = self.post_json(
                    self.instruction_path(),
                    {"action": "list", "bid": bad},
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"], "Invalid request")

        batch_bad = self.post_json(
            self.batch_path(),
            {"action": "batch", "actions": [{"action": "list"}], "bid": "not-hex"},
        )
        self.assertEqual(batch_bad.status_code, 400)

        claim_bad = self.client.get(self.instruction_path("next/?bid=not-hex"))
        self.assertEqual(claim_bad.status_code, 400)
        self.assertEqual(claim_bad.json()["error"], "Invalid request")

    def test_untargeted_claimant_does_not_steal_targeted(self) -> None:
        targeted = self.post_json(
            self.instruction_path(),
            {"action": "list", "bid": self.BID_A},
        )
        instruction_id = targeted.json()["id"]

        empty = self.client.get(self.instruction_path("next/"))
        self.assertEqual(empty.status_code, 204)

        wrong = self.client.get(
            self.instruction_path(f"next/?bid={self.BID_B}"),
        )
        self.assertEqual(wrong.status_code, 204)

        row = Instruction.objects.get(id=instruction_id)
        self.assertEqual(row.status, Instruction.Status.PENDING)

        claimed = self.client.get(
            self.instruction_path(f"next/?bid={self.BID_A}"),
        )
        self.assertEqual(claimed.status_code, 200)
        self.assertEqual(claimed.json()[0]["id"], instruction_id)
        self.assertEqual(claimed.json()[0]["bid"], self.BID_A)

    def test_targeted_claim_returns_untargeted_plus_matching(self) -> None:
        first = self.post_json(self.instruction_path(), {"action": "list"})
        second = self.post_json(
            self.instruction_path(),
            {"action": "list", "bid": self.BID_A},
        )
        self.post_json(
            self.instruction_path(),
            {"action": "list", "bid": self.BID_B},
        )
        first_id = first.json()["id"]
        second_id = second.json()["id"]

        claimed = self.client.get(
            self.instruction_path(f"next/?bid={self.BID_A}&limit=10"),
        )
        self.assertEqual(claimed.status_code, 200)
        self.assertEqual(
            [entry["id"] for entry in claimed.json()],
            [first_id, second_id],
        )
        self.assertIsNone(claimed.json()[0]["bid"])
        self.assertEqual(claimed.json()[1]["bid"], self.BID_A)

        # Only the B-targeted instruction remains; untargeted claimants see nothing.
        self.assertEqual(
            self.client.get(self.instruction_path("next/")).status_code, 204
        )
        remaining = self.client.get(
            self.instruction_path(f"next/?bid={self.BID_B}"),
        )
        self.assertEqual(remaining.status_code, 200)
        self.assertEqual(remaining.json()[0]["bid"], self.BID_B)
        self.assertEqual(
            self.client.get(
                self.instruction_path(f"next/?bid={self.BID_C}")
            ).status_code,
            204,
        )

    def test_complete_records_executor_bid_from_body(self) -> None:
        created = self.post_json(self.instruction_path(), {"action": "list"})
        instruction_id = created.json()["id"]
        self.assertIsNone(created.json()["bid"])
        self.client.get(self.instruction_path("next/"))

        completed = self.post_result(
            instruction_id,
            {"result": [], "bid": self.BID_A},
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["bid"], self.BID_A)

        row = Instruction.objects.get(id=instruction_id)
        self.assertEqual(row.bid, self.BID_A)
        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["bid"], self.BID_A)

    def test_complete_records_executor_bid_from_query_param(self) -> None:
        created = self.post_json(self.instruction_path(), {"action": "list"})
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        completed = self.post_result(
            instruction_id,
            {"result": []},
            query=f"?bid={self.BID_B}",
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["bid"], self.BID_B)
        self.assertEqual(Instruction.objects.get(id=instruction_id).bid, self.BID_B)

    def test_complete_keeps_target_bid_when_executor_differs(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "list", "bid": self.BID_A},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path(f"next/?bid={self.BID_A}"))

        completed = self.post_result(
            instruction_id,
            {"result": [], "bid": self.BID_B},
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["bid"], self.BID_A)
        self.assertEqual(Instruction.objects.get(id=instruction_id).bid, self.BID_A)

    def test_complete_rejects_invalid_query_bid(self) -> None:
        created = self.post_json(self.instruction_path(), {"action": "list"})
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        rejected = self.post_result(
            instruction_id,
            {"result": []},
            query="?bid=not-hex",
        )
        self.assertEqual(rejected.status_code, 400)

    def test_batch_bid_persisted_and_claim_filtered(self) -> None:
        created = self.post_json(
            self.batch_path(),
            {
                "action": "batch",
                "actions": [{"action": "list"}],
                "bid": self.BID_A,
            },
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()["bid"], self.BID_A)
        self.assertEqual(
            Instruction.objects.get(id=created.json()["id"]).bid, self.BID_A
        )

        self.assertEqual(
            self.client.get(self.instruction_path("next/")).status_code, 204
        )
        claimed = self.client.get(
            self.instruction_path(f"next/?bid={self.BID_A}"),
        )
        self.assertEqual(claimed.status_code, 200)
        self.assertEqual(claimed.json()[0]["bid"], self.BID_A)

    def test_terminal_responses_persist_and_are_never_requeued(self) -> None:
        created = self.post_json(self.instruction_path(), {"action": "list"})
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))
        completed = self.post_result(instruction_id, {"result": []})
        self.assertEqual(completed.json()["status"], "completed")

        first = self.client.get(self.instruction_path(f"{instruction_id}/"))
        second = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json(), second.json())
        self.assertTrue(Instruction.objects.filter(id=instruction_id).exists())

        failed_created = self.post_json(self.instruction_path(), {"action": "list"})
        failed_id = failed_created.json()["id"]
        self.client.get(self.instruction_path("next/"))
        self.post_result(failed_id, {"error": "boom"})
        failed_first = self.client.get(self.instruction_path(f"{failed_id}/"))
        failed_second = self.client.get(self.instruction_path(f"{failed_id}/"))
        self.assertEqual(failed_first.status_code, 200)
        self.assertEqual(failed_second.json(), failed_first.json())
        self.assertTrue(Instruction.objects.filter(id=failed_id).exists())

        # Completed/failed rows are never claimed again.
        self.assertEqual(
            self.client.get(self.instruction_path("next/")).status_code, 204
        )
        self.assertEqual(
            self.client.get(
                self.instruction_path(f"next/?bid={self.BID_A}")
            ).status_code,
            204,
        )


class MediaStorageTests(TestCase):
    def test_store_media_writes_bytes_and_returns_the_url_path(self) -> None:
        with (
            tempfile.TemporaryDirectory() as media_dir,
            override_settings(MEDIA_ROOT=Path(media_dir)),
        ):
            url_path = store_media(b"png", "screenshot-12-abc.png")
            stored_bytes = (Path(media_dir) / "screenshot-12-abc.png").read_bytes()

        self.assertEqual(url_path, "/api/media/screenshot-12-abc.png")
        self.assertEqual(stored_bytes, b"png")

    def test_store_media_creates_the_media_root(self) -> None:
        with tempfile.TemporaryDirectory() as media_dir:
            root = Path(media_dir) / "nested" / "media"
            with override_settings(MEDIA_ROOT=root):
                store_media(b"png", "shot.png")
                stored_bytes = (root / "shot.png").read_bytes()
        self.assertEqual(stored_bytes, b"png")

    def test_store_media_raises_when_the_write_fails(self) -> None:
        with tempfile.TemporaryDirectory() as media_dir:
            root = Path(media_dir)
            (root / "shot.png").mkdir()
            with (
                override_settings(MEDIA_ROOT=root),
                self.assertRaisesRegex(StorageError, "Could not store the media file"),
            ):
                store_media(b"png", "shot.png")

    def test_served_media_returns_bytes_and_content_type(self) -> None:
        with tempfile.TemporaryDirectory() as media_dir:
            (Path(media_dir) / "shot.png").write_bytes(b"png-bytes")
            with override_settings(MEDIA_ROOT=Path(media_dir)):
                response = self.client.get("/api/media/shot.png")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            b"".join(cast("Iterator[bytes]", response)),
            b"png-bytes",
        )
        self.assertEqual(response.headers["Content-Type"], "image/png")

    def test_unknown_media_is_404(self) -> None:
        with (
            tempfile.TemporaryDirectory() as media_dir,
            override_settings(MEDIA_ROOT=Path(media_dir)),
        ):
            response = self.client.get("/api/media/missing.png")

        self.assertEqual(response.status_code, 404)

    def test_media_names_are_basenames_only(self) -> None:
        with tempfile.TemporaryDirectory() as media_dir:
            (Path(media_dir) / "secret.png").write_bytes(b"secret")
            with override_settings(MEDIA_ROOT=Path(media_dir)):
                response = self.client.get("/api/media/..%2Fsecret.png")

        self.assertEqual(response.status_code, 404)
