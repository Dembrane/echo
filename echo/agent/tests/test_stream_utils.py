from stream_utils import parse_json_event_stream


def test_parse_json_event_stream_parses_complete_lines():
    chunks = ['{"type":"A"}\n{"type":"B"}\n']
    events = parse_json_event_stream(chunks)
    assert events == [{"type": "A"}, {"type": "B"}]


def test_parse_json_event_stream_handles_partial_chunks():
    chunks = ['{"type":"A"', '}\n{"type":"B"}\n']
    events = parse_json_event_stream(chunks)
    assert events == [{"type": "A"}, {"type": "B"}]


def test_parse_json_event_stream_skips_invalid_lines():
    chunks = ['{"type":"A"}\nnot-json\n{"type":"B"}\n']
    events = parse_json_event_stream(chunks)
    assert events == [{"type": "A"}, {"type": "B"}]
