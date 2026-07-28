import base64
import json

from django.core.exceptions import ValidationError
from django.test import TestCase

from .models import Instruction, Screenshot


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

    def test_instruction_flow(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "list"},
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
        instruction = Instruction.objects.create(bid=self.BID, action="tabs")

        pending = self.client.get(self.instruction_path(f"{instruction.id}/"))
        processing = self.client.get(self.instruction_path("next/")).json()[0]

        self.assertEqual(pending.json()["status"], "pending")
        self.assertEqual(processing["status"], "processing")
        self.assertTrue(Instruction.objects.filter(id=instruction.id).exists())

    def test_browser_queues_are_isolated(self):
        other_bid = "fedcba9876544210a9876543210fedcb"
        created = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "list"},
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
            Instruction.objects.create(bid=self.BID, action="tabs") for _ in range(6)
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
                    {"action": "tabs", "operation": "list"},
                )
                self.assertEqual(response.status_code, 404)

    def test_model_validates_browser_id(self):
        instruction = Instruction(bid="0" * 32, action="tabs")

        with self.assertRaises(ValidationError):
            instruction.full_clean()

    def test_failed_instruction(self):
        instruction = Instruction.objects.create(bid=self.BID, action="tabs")
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
            action="tabs",
            status=Instruction.Status.PROCESSING,
        )

        response = self.client.get(self.instruction_path("next/"))

        self.assertEqual(response.status_code, 204)

    def test_accepts_grouped_tab_operations(self):
        list_tabs = self.post_json(
            self.instruction_path(), {"action": "tabs", "operation": "list"}
        )
        close_tab = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "close", "tid": 12},
        )
        focus_tab = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "focus", "tid": 12},
        )
        navigate_new_tab = self.post_json(
            self.instruction_path(),
            {
                "action": "tabs",
                "operation": "navigate",
                "url": "https://example.com/new",
            },
        )
        navigate_existing_tab = self.post_json(
            self.instruction_path(),
            {
                "action": "tabs",
                "operation": "navigate",
                "tid": 12,
                "url": "https://example.com/existing",
            },
        )

        self.assertEqual(list_tabs.status_code, 201)
        self.assertEqual(list_tabs.json()["payload"]["operation"], "list")
        self.assertEqual(close_tab.status_code, 201)
        self.assertEqual(close_tab.json()["payload"]["tid"], 12)
        self.assertEqual(focus_tab.status_code, 201)
        self.assertEqual(focus_tab.json()["payload"]["operation"], "focus")
        self.assertEqual(focus_tab.json()["payload"]["tid"], 12)
        self.assertEqual(navigate_new_tab.status_code, 201)
        self.assertNotIn("tid", navigate_new_tab.json()["payload"])
        self.assertEqual(navigate_existing_tab.status_code, 201)
        self.assertEqual(navigate_existing_tab.json()["payload"]["tid"], 12)

    def test_tab_operation_is_required(self):
        response = self.post_json(self.instruction_path(), {"action": "tabs"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "tabs.operation")
        self.assertEqual(response.json()["details"][0]["type"], "missing")

    def test_close_tab_requires_tid(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "close"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "tabs")

    def test_focus_tab_requires_tid(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "focus"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "tabs")

    def test_rejects_removed_new_tab_operation(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "new"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "tabs.operation")

    def test_other_tab_operations_reject_url(self):
        response = self.post_json(
            self.instruction_path(),
            {
                "action": "tabs",
                "operation": "list",
                "url": "https://example.com",
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "tabs")

    def test_navigate_requires_url(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "navigate"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "tabs")

    def test_navigate_rejects_empty_url(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "navigate", "url": "  "},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["details"][0]["field"], "tabs.url")

    def test_rejects_result_with_error(self):
        instruction = Instruction.objects.create(bid=self.BID, action="tabs")
        self.client.get(self.instruction_path("next/"))

        response = self.post_result(
            instruction.id,
            {"result": [], "error": "Browser is unavailable"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "body")

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

    def test_screenshot_result_and_download_are_single_use(self):
        image = b"\x89PNG\r\n\x1a\nACOB"
        encoded = base64.b64encode(image).decode()
        created = self.post_json(
            self.instruction_path(),
            {"action": "screenshot", "tid": 12, "full_page": True},
        )
        instruction_id = created.json()["id"]
        self.client.get(self.instruction_path("next/"))

        completed = self.post_result(
            instruction_id,
            {"result": {"data": encoded}},
        )

        self.assertEqual(completed.status_code, 200)
        result = completed.json()["result"]
        self.assertTrue(result["single_use"])
        self.assertTrue(result["full_page"])
        screenshot = Screenshot.objects.get()
        self.assertEqual(screenshot.data, encoded)

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["result"], result)
        self.assertFalse(Instruction.objects.filter(id=instruction_id).exists())
        self.assertTrue(Screenshot.objects.filter(id=screenshot.id).exists())

        download = self.client.get(result["download_url"])
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.content, image)
        self.assertEqual(download.headers["Content-Type"], "image/png")
        self.assertEqual(download.headers["Cache-Control"], "no-store")
        self.assertEqual(
            download.headers["Content-Disposition"],
            f'attachment; filename="acob-screenshot-{screenshot.id}.png"',
        )
        self.assertFalse(Screenshot.objects.filter(id=screenshot.id).exists())
        self.assertEqual(
            self.client.get(result["download_url"]).status_code,
            404,
        )

    def test_screenshot_download_is_scoped_to_browser(self):
        screenshot = Screenshot.objects.create(
            bid=self.BID,
            tid=12,
            data=base64.b64encode(b"image").decode(),
        )
        other_bid = "fedcba9876544210a9876543210fedcb"
        other_url = f"/api/browsers/{other_bid}/screenshots/{screenshot.id}/"
        download_url = f"/api/browsers/{self.BID}/screenshots/{screenshot.id}/"

        self.assertEqual(self.client.get(other_url).status_code, 404)
        self.assertTrue(Screenshot.objects.filter(id=screenshot.id).exists())
        self.assertEqual(self.client.get(download_url).status_code, 200)

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
        self.assertFalse(Screenshot.objects.exists())
