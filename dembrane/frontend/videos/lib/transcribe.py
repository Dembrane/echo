"""Transcribes the narrator's cut lines, so captions match what was said.

Reads JSON from stdin: {"lang": "en", "model": "large-v3-turbo", "lines": [{"file": ..., "prompt": ...}]}
and prints a JSON list of texts in the same order. The prompt is the scripted line, which helps
with names and spelling. Needs `pip install faster-whisper`; the model downloads once.
"""

import json
import sys

from faster_whisper import WhisperModel

job = json.load(sys.stdin)
model = WhisperModel(job["model"], device="cpu", compute_type="int8")
texts = []
for line in job["lines"]:
    segments, _ = model.transcribe(
        line["file"],
        language=job["lang"],
        initial_prompt=line["prompt"],
        beam_size=5,
        vad_filter=False,
        condition_on_previous_text=False,
    )
    texts.append(" ".join(s.text.strip() for s in segments).strip())
print(json.dumps(texts))
