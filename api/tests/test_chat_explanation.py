from parser import IncrementalTagParser
from validator import validate_and_repair


def test_streamed_caption_preserves_separate_chat_explanation():
    parser = IncrementalTagParser()
    events = []
    for chunk in ['[text: content="Resolve gravity.', '" explanation="Split gravity into two', ' perpendicular components."]']:
        events.extend(parser.feed(chunk))
    events.extend(parser.flush())
    primitive = next(event for event in events if event["event"] == "primitive")
    ok, tag = validate_and_repair(primitive["tag"])
    assert ok
    assert tag["args"]["content"] == "Resolve gravity."
    assert tag["args"]["explanation"] == "Split gravity into two perpendicular components."
