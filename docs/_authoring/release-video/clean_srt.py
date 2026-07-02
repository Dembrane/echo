#!/usr/bin/env python3
"""De-duplicate a YouTube rolling-window SRT into clean prose.

YouTube auto-caption cues each show a window of text; the *new* content is the
last non-empty line of each cue. Take that, drop consecutive repeats, reflow.
"""
import re
import sys

src = sys.argv[1] if len(sys.argv) > 1 else "source.en.srt"
with open(src, encoding="utf-8") as f:
    raw = f.read()

# Split into cue blocks separated by blank lines.
blocks = re.split(r"\n\s*\n", raw)
new_lines = []
for b in blocks:
    lines = [l for l in b.splitlines() if l.strip()]
    # drop index line and timestamp line
    lines = [l for l in lines if not re.match(r"^\d+$", l.strip())]
    lines = [l for l in lines if "-->" not in l]
    if not lines:
        continue
    last = lines[-1].strip()
    if last and (not new_lines or new_lines[-1] != last):
        new_lines.append(last)

text = " ".join(new_lines)
text = re.sub(r"\s+", " ", text).strip()

# Light readability: paragraph break after sentence-final punctuation now and then.
sentences = re.split(r"(?<=[.!?]) ", text)
paras, cur = [], []
for s in sentences:
    cur.append(s)
    if len(cur) >= 3:
        paras.append(" ".join(cur))
        cur = []
if cur:
    paras.append(" ".join(cur))

print("\n\n".join(paras))
