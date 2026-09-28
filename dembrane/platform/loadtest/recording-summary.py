#!/usr/bin/env python3
"""Folds one recording run (k6's summary, run.sh's 5 s samples, the transcript timings)
into the result JSON, and decides whether participants struggled: ping failures above
1%, any health stream failure, chunk registration p95 over 2 s, or transcript lag that
keeps rising (the last minute's p95 above both 30 s and 1.5x the best minute's, or more
chunks waiting at the end of the session than there are participants)."""

import argparse
import json
import os
import re
from collections import Counter

ap = argparse.ArgumentParser()
ap.add_argument("summary")
ap.add_argument("samples")
for a in ("stack", "budget", "session", "stream", "chunk-concurrency", "lag", "lag-by-minute",
          "directus", "api-log", "worker-log"):
    ap.add_argument(f"--{a}", default="")
for a in ("vus", "errors", "left", "drain-s", "api-peak", "worker-peak"):
    ap.add_argument(f"--{a}", type=lambda v: int(v) if v.strip().isdigit() else 0, default=0)
for a in ("k6-start", "k6-end", "load"):
    ap.add_argument(f"--{a}", type=float, default=0.0)
args = ap.parse_args()

m = json.load(open(args.summary))["metrics"]


def trend(name, stat="p(95)"):
    v = m.get(name, {}).get(stat)
    return round(v, 1) if v is not None else None


def rate(name):
    v = m.get(name)
    return None if v is None else round(v.get("value", 0), 5)


def count(name):
    return int(m.get(name, {}).get("count", 0))


def fails(name):
    return int(m.get(name, {}).get("fails", 0))


def passes(name):
    return int(m.get(name, {}).get("passes", 0))


samples = [json.loads(line) for line in open(args.samples) if line.strip()]
window = [s for s in samples if args.k6_start <= s["t"] <= args.k6_end]


def cpu_pct(key, rows):
    """Mean and peak (over any 30 s) CPU of a scope, in percent of one core."""
    if len(rows) < 2:
        return None, None
    mean = (rows[-1][key] - rows[0][key]) / 1e9 / (rows[-1]["t"] - rows[0]["t"]) * 100
    peak = 0.0
    for i, a in enumerate(rows):
        for b in rows[i + 1:]:
            if b["t"] - a["t"] >= 30:
                peak = max(peak, (b[key] - a[key]) / 1e9 / (b["t"] - a["t"]) * 100)
                break
    return round(mean), round(peak)


api_mean, api_peak = cpu_pct("api_cpu_ns", window)
w_mean, w_peak = cpu_pct("worker_cpu_ns", window)
db_mean, db_peak = cpu_pct("db_cpu_ns", window) if window and "db_cpu_ns" in window[0] else (None, None)
dx_mean, dx_peak = cpu_pct("directus_cpu_ns", window) if window and "directus_cpu_ns" in window[0] else (None, None)
n_lag, lag_p50, lag_p95 = (args.lag.split() + ["0", "0", "0"])[:3]
by_minute = json.loads(args.lag_by_minute or "[]")
session_rows = [s for s in window if s["t"] <= args.k6_end]
transcribed_run = (window[-1]["transcribed"] - window[0]["transcribed"]) if len(window) > 1 else 0
span = (window[-1]["t"] - window[0]["t"]) if len(window) > 1 else 1


def log_errors(path):
    """The distinct error lines a process logged, most frequent first."""
    try:
        text = open(path, errors="replace").read()
    except OSError:
        return []
    pat = re.compile(r"(error|exception|traceback|too many|refused|timeout|killed|oom)", re.I)
    lines = [re.sub(r"[0-9a-f]{8}-[0-9a-f-]{27}", "<id>", ln.strip())[:220]
             for ln in text.splitlines() if pat.search(ln)]
    lines = [re.sub(r"\d{2}:\d{2}:\d{2}[.,]?\d*", "", ln) for ln in lines]
    return [{"count": c, "line": ln} for ln, c in Counter(lines).most_common(5)]


ping_total = passes("ping_ok") + fails("ping_ok")
ping_fail = fails("ping_ok") / ping_total if ping_total else 1.0
reg_p95 = trend("confirm_ms")
stream_failed = count("stream_failed")
# The session's last minute holds each participant's final chunk, uploaded with the
# finish that starts summaries; it measures the finish, not whether transcription keeps up.
session_min = int(float(args.session[:-1]) * (1 if args.session.endswith("m") else 1 / 60))
full = [x for x in by_minute if x["minute"] < session_min and x["chunks"] >= max(3, args.vus // 2)]
best = min((x["p95_s"] for x in full), default=0)
last = full[-1]["p95_s"] if full else 0
lag_growing = bool(full) and last > max(30.0, 1.5 * best)
reasons = []
pipeline = []
if ping_fail > 0.01:
    reasons.append(f"ping failures {ping_fail:.1%}")
if stream_failed:
    reasons.append(f"{stream_failed} health stream failures")
if reg_p95 is not None and reg_p95 > 2000:
    reasons.append(f"chunk registration p95 {reg_p95 / 1000:.1f} s")
if (rate("chunk_ok") or 0) < 0.99:
    reasons.append(f"chunk uploads failed {(1 - (rate('chunk_ok') or 0)):.1%}")
if (rate("join_ok") or 0) < 0.99:
    reasons.append(f"joins failed {(1 - (rate('join_ok') or 0)):.1%}")
if lag_growing:
    pipeline.append(f"transcript lag rising: best minute p95 {best} s, last {last} s")
# In flight when keeping up: arrivals (one chunk per participant per 30 s) times the
# transcriber's ~12 s worst case, about 0.4 per participant. Above one per participant at
# the end of the session the worker is behind.
backlog_end = session_rows[-1]["waiting"] if session_rows else 0
if backlog_end > args.vus:
    pipeline.append(f"transcript backlog {backlog_end} chunks at session end")

print(json.dumps({
    "stack": args.stack,
    "scenario": "recording",
    "budget": args.budget,
    "participants": args.vus,
    "session": args.session,
    "health_stream": args.stream != "0",
    "chunk_concurrency": args.chunk_concurrency,
    "worker_pool_max": int(os.environ.get("WORKER_POOL_MAX") or 10) if args.stack == "new" else None,
    "media": os.environ.get("MEDIA") or ("in-worker" if args.stack == "new" else "cpu worker"),
    "join": {"ok_rate": rate("join_ok"), "p95_ms": trend("join_ms")},
    "ping": {"count": ping_total, "fail_rate": round(ping_fail, 5), "p50_ms": trend("ping_ms", "p(50)"),
             "p95_ms": trend("ping_ms"), "max_ms": trend("ping_ms", "max")},
    "stream": {"opened": count("stream_opened"), "failed": stream_failed},
    "chunks": {"ok_rate": rate("chunk_ok"), "uploaded": passes("chunk_ok"), "failed": fails("chunk_ok"),
               "upload_url_p95_ms": trend("upload_url_ms"), "s3_upload_p95_ms": trend("s3_upload_ms"),
               "registration_p50_ms": trend("confirm_ms", "p(50)"), "registration_p95_ms": reg_p95,
               "total_p95_ms": trend("chunk_total_ms")},
    "polls_ok_rate": rate("poll_ok"),
    "finish_ok_rate": rate("finish_ok"),
    "transcription": {
        "transcribed": int(n_lag), "lag_p50_s": float(lag_p50), "lag_p95_s": float(lag_p95),
        "lag_by_minute": by_minute, "errors": args.errors, "left_after_drain": args.left,
        "drain_s": args.drain_s,
        "backlog_peak": max((s["waiting"] for s in session_rows), default=0),
        "backlog_at_end": session_rows[-1]["waiting"] if session_rows else 0,
        "throughput_per_s": round(transcribed_run / span, 2),
    },
    "api": {"cpu_mean_pct": api_mean, "cpu_peak_30s_pct": api_peak, "peak_memory_bytes": args.api_peak,
            "directus_memory": args.directus,
            "directus_cpu_mean_pct": dx_mean if args.stack == "old" else None, "errors": log_errors(args.api_log)},
    "worker": {"cpu_mean_pct": w_mean, "cpu_peak_30s_pct": w_peak, "peak_memory_bytes": args.worker_peak,
               "errors": log_errors(args.worker_log)},
    "db": {"cpu_mean_pct": db_mean, "cpu_peak_30s_pct": db_peak, "connections_peak": max((s["db_conns"] for s in window), default=0),
           "busy_peak": max((s["db_busy"] for s in window), default=0)},
    "http_failed_rate": rate("http_req_failed"),
    "host_load_1m": args.load,
    "struggling": reasons + pipeline,
    # The API side alone (pings, stream, uploads), and end to end with the transcripts.
    "api_sustained": not reasons,
    "sustained": not reasons and not pipeline,
}, indent=1))
