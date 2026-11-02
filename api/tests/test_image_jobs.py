import asyncio
import base64
import io
import json
import time

import httpx
import pytest
from PIL import Image

from learning import image_jobs
from learning.board_storage import BoardStore
from learning.router import COOKIE
from learning.tutor_storage import TutorStore
from test_tutor_turn import SEG, WRITE, FakeTutor, ask, doc, env, events  # noqa: F401

DONE = {"type": "turn_end", "reason": "done"}
IMAGE = {"type": "image", "prompt": "A lighthouse beam sweeping across a dark sea", "alt": "A beam picks out one boat"}


def webp() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (48, 32), (40, 90, 200)).save(out, format="WEBP")
    return out.getvalue()


def wait_for(client, sid, image_id, status=("ready", "failed"), seconds=5.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        value = client.get(f"/learning/sessions/{sid}/images/{image_id}").json()
        if value["status"] in status:
            return value
        time.sleep(0.02)
    raise AssertionError(f"image stayed {value['status']}")


@pytest.fixture(autouse=True)
def one_loop(env):
    """Keep one event loop for the whole test, as uvicorn does; background jobs outlive their request."""
    with env[0]:
        yield


@pytest.fixture
def paid(monkeypatch):
    """Scripted Muse Image: records prompts, returns a real WebP or raises a failure."""
    calls, outcome = [], {"result": webp()}

    async def generate(client, key, prompt):
        calls.append(prompt)
        await asyncio.sleep(0.01)
        if isinstance(outcome["result"], Exception):
            raise outcome["result"]
        return outcome["result"]

    monkeypatch.setenv("MODEL_API_KEY", "test-key")
    monkeypatch.setattr(image_jobs, "generate", generate)
    return calls, outcome


def test_image_move_starts_a_job_and_the_lesson_never_waits(env, paid):
    client, capture, owner, sid, holder = env
    calls, _ = paid
    holder["tutor"] = FakeTutor([doc(SEG, IMAGE, WRITE, DONE)])
    _, response = ask(client, sid)
    moves = [v["move"] for n, v in events(response) if n == "move"]
    assert [m["type"] for m in moves] == ["seg", "image", "write", "turn_end"]
    image_id = moves[1]["image_id"]
    assert len(image_id) == 32 and moves[1]["alt"] == IMAGE["alt"]
    ready = wait_for(client, sid, image_id)
    assert ready["status"] == "ready" and len(ready["asset_hash"]) == 64
    asset = BoardStore(capture).get_asset(owner, sid, ready["asset_hash"])
    assert asset["mime"] == "image/webp"
    assert calls == [IMAGE["prompt"]]  # the style suffix is added inside generate, never by the browser
    stored = TutorStore(capture).history(owner, str(sid))[-1]
    assert stored["moves"][1]["image_id"] == image_id


def test_replay_reuses_the_job_without_a_second_paid_call(env, paid):
    client, capture, owner, sid, holder = env
    calls, _ = paid
    holder["tutor"] = FakeTutor([doc(SEG, IMAGE, DONE)])
    body, first = ask(client, sid)
    image_id = [v["move"] for n, v in events(first) if n == "move"][1]["image_id"]
    wait_for(client, sid, image_id)
    again = client.post(f"/learning/sessions/{sid}/tutor/turns", json=body)
    assert [v["move"].get("image_id") for n, v in events(again) if n == "move"][1] == image_id
    assert len(calls) == 1


def test_failed_image_is_recorded_and_the_turn_is_intact(env, paid):
    client, capture, owner, sid, holder = env
    _, outcome = paid
    outcome["result"] = image_jobs.ImageFailure("image_timeout")
    holder["tutor"] = FakeTutor([doc(SEG, IMAGE, WRITE, DONE)])
    _, response = ask(client, sid)
    got = events(response)
    assert got[-1][1]["status"] == "done"
    image_id = [v["move"] for n, v in got if n == "move"][1]["image_id"]
    assert wait_for(client, sid, image_id) | {"ms": None} == {"image_id": image_id, "status": "failed", "asset_hash": None,
                                                              "alt": IMAGE["alt"], "error": "image_timeout", "ms": None}


def test_budget_and_missing_key_fail_before_any_paid_call(env, paid, monkeypatch):
    client, capture, owner, sid, holder = env
    calls, _ = paid
    monkeypatch.setattr(image_jobs, "HOURLY_IMAGES", 1)
    holder["tutor"] = FakeTutor([doc(SEG, IMAGE, DONE), doc(SEG, IMAGE, DONE), doc(SEG, IMAGE, DONE)])
    ids = []
    for _ in range(2):
        _, response = ask(client, sid)
        ids.append([v["move"] for n, v in events(response) if n == "move"][1]["image_id"])
    assert wait_for(client, sid, ids[0])["status"] == "ready"
    assert wait_for(client, sid, ids[1])["error"] == "image_budget"
    monkeypatch.setenv("MODEL_API_KEY", "")
    monkeypatch.setattr(image_jobs, "HOURLY_IMAGES", 10)
    _, response = ask(client, sid)
    third = [v["move"] for n, v in events(response) if n == "move"][1]["image_id"]
    assert wait_for(client, sid, third)["error"] == "image_not_configured"
    assert len(calls) == 1


def test_image_status_is_owner_scoped_and_validated(env, paid):
    client, capture, owner, sid, holder = env
    holder["tutor"] = FakeTutor([doc(SEG, IMAGE, DONE)])
    _, response = ask(client, sid)
    image_id = [v["move"] for n, v in events(response) if n == "move"][1]["image_id"]
    wait_for(client, sid, image_id)
    assert client.get(f"/learning/sessions/{sid}/images/not-an-id").status_code == 422
    assert client.get(f"/learning/sessions/{sid}/images/{'0' * 32}").status_code == 404
    client.cookies.set(COOKIE, capture.issue_identity())  # another learner
    assert client.get(f"/learning/sessions/{sid}/images/{image_id}").status_code in (403, 404)


def test_second_image_in_a_turn_is_dropped(env, paid):
    client, capture, owner, sid, holder = env
    calls, _ = paid
    holder["tutor"] = FakeTutor([doc(SEG, IMAGE, IMAGE, DONE)])
    _, response = ask(client, sid)
    assert [v["move"]["type"] for n, v in events(response) if n == "move"] == ["seg", "image", "turn_end"]


@pytest.mark.parametrize("status, body, code", [
    (401, {}, "image_auth_failed"),
    (429, {}, "image_rate_limited"),
    (500, {}, "image_http_error"),
    (200, {"data": []}, "image_invalid_response"),
    (200, {"data": [{"b64_json": "!!not base64"}]}, "image_invalid_response"),
])
def test_generate_maps_provider_errors(status, body, code):
    async def go():
        transport = httpx.MockTransport(lambda request: httpx.Response(status, json=body))
        async with httpx.AsyncClient(transport=transport) as client:
            await image_jobs.generate(client, "k", "p")
    with pytest.raises(image_jobs.ImageFailure) as error:
        asyncio.run(go())
    assert error.value.code == code


def test_generate_sends_the_model_and_a_no_text_style():
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        seen["auth"] = request.headers["Authorization"]
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(b"RIFF....WEBP").decode()}]})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await image_jobs.generate(client, "k", "A lens")
    assert asyncio.run(go()) == b"RIFF....WEBP"
    assert seen["model"] == "muse-image-1.0" and seen["prompt"].startswith("A lens") and "no text" in seen["prompt"].lower()
    assert seen["auth"] == "Bearer k"
