import json
from datetime import timedelta

from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone

from .models import Instruction


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

    def test_instruction_flow(self):
        created = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "new"},
        )

        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()["bid"], self.BID)
        instruction_id = created.json()["id"]

        next_instruction = self.client.get(self.instruction_path("next/"))
        self.assertEqual(next_instruction.status_code, 200)
        self.assertEqual(next_instruction.json()["id"], instruction_id)
        self.assertEqual(next_instruction.json()["status"], "processing")

        completed = self.post_json(
            self.instruction_path(f"{instruction_id}/result/"),
            {"result": {"url": "about:blank"}},
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(completed.json()["status"], "completed")

        repeated = self.post_json(
            self.instruction_path(f"{instruction_id}/result/"),
            {"result": {"url": "about:blank"}},
        )
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json()["status"], "completed")

        detail = self.client.get(self.instruction_path(f"{instruction_id}/"))
        self.assertEqual(detail.json()["result"], {"url": "about:blank"})
        self.assertEqual(
            self.client.get(self.instruction_path("next/")).status_code,
            204,
        )

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
            self.client.get(self.instruction_path("next/")).json()["id"],
            instruction_id,
        )

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

        response = self.post_json(
            self.instruction_path(f"{instruction.id}/result/"),
            {"error": "Browser is unavailable"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "failed")
        self.assertEqual(response.json()["error"], "Browser is unavailable")

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

    def test_reclaims_stale_instruction(self):
        instruction = Instruction.objects.create(
            bid=self.BID,
            action="tabs",
            status=Instruction.Status.PROCESSING,
        )
        Instruction.objects.filter(id=instruction.id).update(
            updated_at=timezone.now() - timedelta(minutes=2)
        )

        response = self.client.get(self.instruction_path("next/"))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], instruction.id)

    def test_accepts_grouped_tab_operations(self):
        list_tabs = self.post_json(
            self.instruction_path(), {"action": "tabs", "operation": "list"}
        )
        new_tab = self.post_json(
            self.instruction_path(), {"action": "tabs", "operation": "new"}
        )
        close_tab = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "close", "tid": 12},
        )
        focus_tab = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "focus", "tid": 12},
        )

        self.assertEqual(list_tabs.status_code, 201)
        self.assertEqual(list_tabs.json()["payload"]["operation"], "list")
        self.assertEqual(new_tab.status_code, 201)
        self.assertEqual(new_tab.json()["payload"]["operation"], "new")
        self.assertEqual(close_tab.status_code, 201)
        self.assertEqual(close_tab.json()["payload"]["tid"], 12)
        self.assertEqual(focus_tab.status_code, 201)
        self.assertEqual(focus_tab.json()["payload"]["operation"], "focus")
        self.assertEqual(focus_tab.json()["payload"]["tid"], 12)

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

    def test_new_tab_rejects_tid(self):
        response = self.post_json(
            self.instruction_path(),
            {"action": "tabs", "operation": "new", "tid": 12},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")
        self.assertEqual(response.json()["details"][0]["field"], "tabs")

    def test_rejects_result_with_error(self):
        instruction = Instruction.objects.create(bid=self.BID, action="tabs")
        self.client.get(self.instruction_path("next/"))

        response = self.post_json(
            self.instruction_path(f"{instruction.id}/result/"),
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
