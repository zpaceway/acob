from __future__ import annotations

import base64
import json
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING, cast
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.test import TestCase, override_settings

if TYPE_CHECKING:
    from django.test.client import _MonkeyPatchedWSGIResponse

from .models import Instruction, Reinstall
from .recovery import EXTENSION_REINSTALL_ERROR
from .storage import StorageError, store_media


class InstructionApiTests(TestCase):
    BID = "0123456789ab4def8123456789abcdef"

    def instruction_path(self, suffix: str = "") -> str:
        return f"/api/browsers/{self.BID}/instructions/{suffix}"

    def batch_path(self, suffix: str = "") -> str:
        return f"/api/browsers/{self.BID}/instructions/batch/{suffix}"

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
        return f"/api/browsers/{self.BID}/reinstall/{suffix}"

    def test_instruction_flow(self) -> None:
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

    def test_pending_and_processing_reads_are_not_consumed(self) -> None:
        instruction = Instruction.objects.create(bid=self.BID, action="list")

        pending = self.client.get(self.instruction_path(f"{instruction.id}/"))
        processing = self.client.get(self.instruction_path("next/")).json()[0]

        self.assertEqual(pending.json()["status"], "pending")
        self.assertEqual(processing["status"], "processing")
        self.assertTrue(Instruction.objects.filter(id=instruction.id).exists())

    def test_browser_queues_are_isolated(self) -> None:
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

    def test_claims_up_to_the_requested_instruction_limit(self) -> None:
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

    def test_pending_reinstall_blocks_instruction_claims(self) -> None:
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
                    {"action": "scroll", "tid": 12, "y": 500},
                    {"action": "click", "tid": 12, "selector": "button"},
                ],
            },
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["bid"], self.BID)
        self.assertEqual(response.json()["action"], "batch")
        self.assertEqual(
            response.json()["payload"]["actions"],
            [
                {"action": "list"},
                {"action": "scroll", "tid": 12, "y": 500},
                {"action": "click", "tid": 12, "selector": "button"},
            ],
        )
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
        self.assertFalse(Instruction.objects.filter(id=instruction_id).exists())

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
            override_settings(MEDIA_ROOT=Path(media_dir)),
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
                        "url": f"http://testserver/api/media/{stored_name}",
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
                    {"action": "record_start", "tid": 12},
                    {"action": "record_stop", "recording_id": 42},
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
                        {"result": {"recording_id": 42, "started": True}},
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
            stored = list(Path(media_dir).glob("recording-42-*.webm"))
            stored_bytes = stored[0].read_bytes() if stored else b""
            stored_name = stored[0].name if stored else ""

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored_bytes, recording)
        self.assertEqual(
            completed.json()["result"],
            [
                {"result": {"recording_id": 42, "started": True}},
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
                "actions": [{"action": "record_start", "tid": 12}],
            },
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))
        invalid_result = self.post_result(
            instruction_id,
            {"result": [{"result": {"recording_id": 0, "started": True}}]},
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

    def test_rejects_invalid_browser_ids(self) -> None:
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

    def test_model_validates_browser_id(self) -> None:
        instruction = Instruction(bid="0" * 32, action="list")

        with self.assertRaises(ValidationError):
            instruction.full_clean()

    def test_failed_instruction(self) -> None:
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
            bid=self.BID,
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
        instruction = Instruction.objects.create(bid=self.BID, action="list")
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
        self.assertFalse(Instruction.objects.filter(id=instruction_id).exists())

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
        self.assertFalse(Instruction.objects.filter(id=instruction_id).exists())

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

    def test_accepts_record_start_and_record_stop_instructions(self) -> None:
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

    def test_record_start_accepts_full_page_flag(self) -> None:
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

    def test_record_instructions_require_valid_arguments(self) -> None:
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

    def test_record_start_result_is_validated(self) -> None:
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

    def test_record_stop_result_is_stored_locally(self) -> None:
        recording = b"0\x9awEBMACOB"
        encoded = base64.b64encode(recording).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
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
            stored = list(Path(media_dir).glob("recording-42-*.webm"))
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
        self.assertFalse(Instruction.objects.filter(id=instruction_id).exists())

    def test_record_stop_fails_when_media_cannot_be_stored(self) -> None:
        created = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
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

    def test_rejects_invalid_record_stop_result(self) -> None:
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

    def test_record_stop_result_accepts_mp4_content_type(self) -> None:
        recording = b"0\x9awMP4ACOB"
        encoded = base64.b64encode(recording).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "record_stop", "recording_id": 42},
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
            stored = list(Path(media_dir).glob("recording-42-*.mp4"))
            stored_bytes = stored[0].read_bytes() if stored else b""
            stored_name = stored[0].name if stored else ""

        self.assertEqual(completed.status_code, 200)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored_bytes, recording)
        result = completed.json()["result"]
        self.assertEqual(result["content_type"], "video/mp4")
        self.assertEqual(result["duration"], 5.0)
        self.assertEqual(result["stopped_reason"], "user")
        self.assertEqual(result["url"], f"http://testserver/api/media/{stored_name}")

    def test_rejects_unknown_record_stop_content_type(self) -> None:
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

    def test_heartbeat_stores_and_returns_browser_settings(self) -> None:
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

    def test_heartbeat_requires_a_settings_object(self) -> None:
        response = self.post_json(
            f"/api/browsers/{self.BID}/heartbeat/",
            {"settings": []},
        )
        self.assertEqual(response.status_code, 400)

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
