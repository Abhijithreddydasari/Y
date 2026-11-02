"""Live check of evidence labeling against the configured decision model (EVIDENCE_LABEL_PROVIDER; paid calls).

Runs 12 synthetic answered checks through the real capture store and background labeler on a
throwaway SQLite file, then prints each label next to a hand label, and the label latency.
Two ink cases carry the answer only in a rendered image crop (a font, not real stylus strokes),
so they show whether the provider reads learner images; System One ignores images.
Usage (from api): .venv\\Scripts\\python.exe scripts\\live_evidence.py [count]
"""
from __future__ import annotations

import asyncio
import statistics
import sys
import tempfile
import time
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from learning import observations  # noqa: E402
from learning.board_storage import BoardStore  # noqa: E402
from learning.decisions import evidence_labeler  # noqa: E402
from learning.storage import CaptureStore, make_engine  # noqa: E402
from learning.tutor_turn import TurnInput, grade  # noqa: E402


def check(kind, q, key, options=(), concept="attention.scaling", dim="understand"):
    return {"kind": kind, "q": q, "key": key, "options": list(options), "concept": concept, "dim": dim}


SOFTMAX = ["the variance of the dot product", "the mean of the dot product", "nothing changes"]
# (question, learner answer, modality, hand label: outcome, miss class or None)
CASES = [
    (check("mcq", "As d_k grows, what grows with it?", SOFTMAX[0], SOFTMAX), SOFTMAX[0], "tap", ("correct", None)),
    (check("mcq", "As d_k grows, what grows with it?", SOFTMAX[0], SOFTMAX), SOFTMAX[1], "tap", ("incorrect", "discrimination")),
    (check("mcq", "As d_k grows, what grows with it?", SOFTMAX[0], SOFTMAX), SOFTMAX[2], "spoken", ("incorrect", "structural")),
    (check("free", "Why divide attention scores by the square root of d_k?", "to keep the score variance near one"),
     "so the variance of the scores stays around one and softmax does not saturate", "typed", ("correct", None)),
    (check("free", "Why divide attention scores by the square root of d_k?", "to keep the score variance near one"),
     "to make the numbers smaller", "spoken", ("partial", "structural")),
    (check("free", "Why divide attention scores by the square root of d_k?", "to keep the score variance near one"),
     "I don't know", "typed", ("unanswered", None)),
    (check("free", "What is \\sqrt{512}, to one decimal place?", "22.6", concept="arith.roots", dim="apply"), "22.6", "typed", ("correct", None)),
    (check("free", "What is \\sqrt{512}, to one decimal place?", "22.6", concept="arith.roots", dim="apply"), "26.2", "typed", ("incorrect", "careless")),
    (check("free", "Simplify 2(x + 3) - x.", "x + 6", concept="algebra.expand", dim="apply"), "x + 3", "typed", ("incorrect", "execution")),
    (check("free", "What does an eigenvector of A satisfy?", "Av = λv for some scalar λ", concept="linalg.eigen", dim="recall"),
     "A times v is just v scaled by a number", "spoken", ("correct", None)),
    # Planted wrong keys: the first is caught by the deterministic audit, the second only by Elephant.
    (check("free", "What is \\sqrt{64}?", "6", concept="arith.roots", dim="apply"), "8", "typed", ("correct", None)),
    (check("free", "For A = [[2, 0], [0, 3]] and u = (1, 0), what is Au?", "(3, 3)", concept="linalg.matvec", dim="apply"),
     "(2, 0)", "typed", ("correct", None)),
    # Ink: the typed text is only a placeholder; the answer is in the learner's crop.
    (check("free", "What is \sqrt{81}?", "9", concept="arith.roots", dim="apply"), "ink:9", "ink", ("correct", None)),
    (check("free", "What is 7 \times 8?", "56", concept="arith.times", dim="apply"), "ink:54", "ink", ("incorrect", "careless")),
]
INK_PLACEHOLDER = "(answered in ink on the board)"


def ink_png(text: str) -> bytes:
    image = Image.new("RGB", (360, 160), "white")
    try:
        font = ImageFont.truetype("segoepr.ttf", 72)  # Segoe Print: handwriting-like, ships with Windows
    except OSError:
        font = ImageFont.load_default(size=72)
    ImageDraw.Draw(image).text((40, 30), text, fill="#1e3a8a", font=font)
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


async def main(count: int) -> None:
    labeler = evidence_labeler()
    print(f"labeler {labeler.provider_name}:{labeler.model} configured={labeler.configured} (LIVE, paid calls)")
    if not labeler.configured:
        raise SystemExit("the selected provider's key is not set (OPENAI_API_KEY or BASETEN_API_KEY)")
    with tempfile.TemporaryDirectory() as folder:
        capture = CaptureStore(make_engine(f"sqlite:///{Path(folder, 'live.db').as_posix()}"))
        capture.initialize()
        owner = capture.owner_for_token(capture.issue_identity())
        sid = uuid4()
        capture.create_session(owner, sid)
        store = observations.ObservationStore(capture)
        rows, capture_ms = [], []
        for index, (question, answer, via, hand) in enumerate(CASES[:count]):
            question = {**question, "qid": f"live.{index}"}
            crops = ()
            if answer.startswith("ink:"):
                crops = (BoardStore(capture).put_asset(owner, str(sid), ink_png(answer[4:]))["hash"],)
                answer = INK_PLACEHOLDER
            body = TurnInput(turn_id=uuid4(), kind="answer", question_id=question["qid"],
                             **({"choice": answer} if question["options"] else {"text": answer}))
            started = time.perf_counter()
            graded = grade(question, body)
            row, _ = store.capture_answer(owner, str(sid), str(body.turn_id), question, answer, graded, via, [], (), crops)
            capture_ms.append((time.perf_counter() - started) * 1000)
            rows.append((row, hand))
        await asyncio.gather(*(observations.label(store, labeler, owner, row["observation_id"])
                               for row, _ in rows if row["status"] == "pending"))
        final = {r["observation_id"]: r for r in store.entries(owner, str(sid))}
        agree, latencies = 0, []
        print("qid      modality  key      hand outcome/miss            label outcome/miss (p)                       status/error")
        for row, hand in rows:
            done = final[row["observation_id"]]
            obs, fields = done["observation"] or {}, done["fields"] or {}
            p = {k: v["p"] for k, v in fields.items()}
            got = (obs.get("outcome"), obs.get("miss_class"))
            agree += got[0] == hand[0]
            if done["label_ms"] is not None and done["status"] == "labeled":
                latencies.append(done["label_ms"])
            print(f"{done['qid']:<8} {done['modality']:<9} {done['key_status']:<8} {hand[0]:>10}/{str(hand[1]):<15} "
                  f"{str(got[0]):>10}/{str(got[1]):<15} {p}  {done['status']}/{done['error']}")
        print(f"outcome agreement with hand labels: {agree}/{len(rows)}")
        print(f"capture (verify + insert) ms: median {statistics.median(capture_ms):.1f}, max {max(capture_ms):.1f}")
        if latencies:
            print(f"label ms (labeled rows, 2 concurrent): {[round(v) for v in latencies]} "
                  f"p50 {statistics.median(latencies):.0f} max {max(latencies):.0f}")
        capture.engine.dispose()


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else len(CASES)))
