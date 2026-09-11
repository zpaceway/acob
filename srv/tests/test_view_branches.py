from __future__ import annotations

import json
from typing import TYPE_CHECKING
from unittest.mock import patch

from django.db.models.query import QuerySet
from django.test import RequestFactory, TestCase

from api.models import Instruction, Reinstall
from api.views import serve_media

if TYPE_CHECKING:
    from django.test.client import _MonkeyPatchedWSGIResponse


class ModelStrTests(TestCase):
    def test_instruction_str_includes_action_and_id(self) -> None:
        instruction = Instruction.objects.create(action="list")

        self.assertIn("list", str(instruction))
        self.assertIn(str(instruction.id), str(instruction))

    def test_reinstall_str_includes_token(self) -> None:
        reinstall = Reinstall.objects.create()

        self.assertIn("reinstall", str(reinstall))
        self.assertIn(str(reinstall.token), str(reinstall))


class DetailAndCompleteEdgeTests(TestCase):
    def post_json(self, path: str, data: object) -> _MonkeyPatchedWSGIResponse:
        return self.client.post(
            path,
            data=json.dumps(data),
            content_type="application/json",
        )

    def test_detail_404_for_unknown_id(self) -> None:
        response = self.client.get("/api/instructions/999999/")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"], "Instruction not found")

    def test_complete_404_for_unknown_id(self) -> None:
        response = self.post_json("/api/instructions/999999/result/", {"result": []})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"], "Instruction not found")

    def test_complete_409_when_not_processing(self) -> None:
        instruction = Instruction.objects.create(action="list")

        response = self.post_json(
            f"/api/instructions/{instruction.id}/result/", {"result": []}
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"], "Instruction is not processing")

    def test_acknowledge_rejects_invalid_body(self) -> None:
        response = self.post_json("/api/reinstall/acknowledge/", {"token": "bad"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")


class BatchPayloadEdgeTests(TestCase):
    def post_json(self, path: str, data: object) -> _MonkeyPatchedWSGIResponse:
        return self.client.post(
            path,
            data=json.dumps(data),
            content_type="application/json",
        )

    def test_batch_payload_not_a_list_is_rejected(self) -> None:
        instruction = Instruction.objects.create(
            action=Instruction.Action.BATCH,
            payload={"actions": "not-a-list"},
            status=Instruction.Status.PROCESSING,
        )

        response = self.post_json(
            f"/api/instructions/{instruction.id}/result/",
            {"result": [{"result": []}]},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Batch payload is invalid")

    def test_batch_non_dict_entry_passes_through(self) -> None:
        instruction = Instruction.objects.create(
            action=Instruction.Action.BATCH,
            payload={"actions": ["not-a-dict"]},
            status=Instruction.Status.PROCESSING,
        )

        response = self.post_json(
            f"/api/instructions/{instruction.id}/result/",
            {"result": [{"result": []}]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["result"], [{"result": []}])

    def test_batch_entry_without_action_passes_through(self) -> None:
        instruction = Instruction.objects.create(
            action=Instruction.Action.BATCH,
            payload={"actions": [{"foo": "bar"}]},
            status=Instruction.Status.PROCESSING,
        )

        response = self.post_json(
            f"/api/instructions/{instruction.id}/result/",
            {"result": [{"result": []}]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["result"], [{"result": []}])


class ActionPayloadEdgeTests(TestCase):
    def post_json(self, path: str, data: object) -> _MonkeyPatchedWSGIResponse:
        return self.client.post(
            path,
            data=json.dumps(data),
            content_type="application/json",
        )

    def test_record_payload_invalid(self) -> None:
        instruction = Instruction.objects.create(
            action=Instruction.Action.RECORD,
            payload={"method": "bogus", "tid": 12},
            status=Instruction.Status.PROCESSING,
        )

        response = self.post_json(
            f"/api/instructions/{instruction.id}/result/",
            {"result": {"started": True}},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Record payload is invalid")

    def test_proxy_payload_invalid(self) -> None:
        instruction = Instruction.objects.create(
            action=Instruction.Action.PROXY,
            payload={"method": "bogus"},
            status=Instruction.Status.PROCESSING,
        )

        response = self.post_json(
            f"/api/instructions/{instruction.id}/result/",
            {"result": {"proxied": False}},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Proxy payload is invalid")

    def test_proxy_unset_invalid_result(self) -> None:
        instruction = Instruction.objects.create(
            action=Instruction.Action.PROXY,
            payload={"method": "unset"},
            status=Instruction.Status.PROCESSING,
        )

        response = self.post_json(
            f"/api/instructions/{instruction.id}/result/",
            {"result": {"proxied": True}},
        )

        self.assertEqual(response.status_code, 400)

    def test_console_payload_invalid(self) -> None:
        instruction = Instruction.objects.create(
            action=Instruction.Action.CONSOLE,
            payload={"method": "bogus", "tid": 12},
            status=Instruction.Status.PROCESSING,
        )

        response = self.post_json(
            f"/api/instructions/{instruction.id}/result/",
            {"result": {"started": True}},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Console payload is invalid")

    def test_screenshot_result_validation_error(self) -> None:
        instruction = Instruction.objects.create(
            action=Instruction.Action.SCREENSHOT,
            payload={"tid": 12},
            status=Instruction.Status.PROCESSING,
        )

        response = self.post_json(
            f"/api/instructions/{instruction.id}/result/", {"result": {}}
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "Invalid request")


class MediaEdgeTests(TestCase):
    def test_serve_media_rejects_traversal_name(self) -> None:
        factory = RequestFactory()
        request = factory.get("/api/media/a/b")

        response = serve_media(request, "a/b")

        self.assertEqual(response.status_code, 404)


class ClaimRaceTests(TestCase):
    def test_claim_breaks_when_reinstall_appears(self) -> None:
        first = Instruction.objects.create(action="list")
        second = Instruction.objects.create(action="list")

        with patch("api.views.Reinstall.objects.exists", side_effect=[False, True]):
            response = self.client.get("/api/instructions/next/?limit=2")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 1)
        self.assertEqual(response.json()[0]["id"], first.id)
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual(first.status, Instruction.Status.PROCESSING)
        self.assertEqual(second.status, Instruction.Status.PENDING)

    def test_claim_retries_when_update_loses_race(self) -> None:
        Instruction.objects.create(action="list")
        original_update = QuerySet.update
        calls = {"count": 0}

        def flaky_update(
            queryset: QuerySet[Instruction], *args: object, **kwargs: object
        ) -> int:
            if "result" not in kwargs and calls["count"] == 0:
                calls["count"] += 1
                return 0
            return original_update(queryset, *args, **kwargs)

        with patch.object(QuerySet, "update", flaky_update):
            response = self.client.get("/api/instructions/next/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 1)


class CompleteRaceTests(TestCase):
    def post_json(self, path: str, data: object) -> _MonkeyPatchedWSGIResponse:
        return self.client.post(
            path,
            data=json.dumps(data),
            content_type="application/json",
        )

    def test_complete_returns_current_when_update_loses_race(self) -> None:
        instruction = Instruction.objects.create(action="list")
        self.client.get("/api/instructions/next/")

        with patch.object(QuerySet, "update", return_value=0):
            response = self.post_json(
                f"/api/instructions/{instruction.id}/result/", {"result": []}
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "processing")

    def test_complete_404_when_row_vanishes_after_update(self) -> None:
        instruction = Instruction.objects.create(action="list")
        self.client.get("/api/instructions/next/")
        instruction_id = instruction.id

        def delete_and_return_zero(*_args: object, **_kwargs: object) -> int:
            Instruction.objects.filter(id=instruction_id).delete()
            return 0

        with patch.object(QuerySet, "update", delete_and_return_zero):
            response = self.post_json(
                f"/api/instructions/{instruction_id}/result/", {"result": []}
            )

        self.assertEqual(response.status_code, 404)
