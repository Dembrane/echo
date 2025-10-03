#!/usr/bin/env python3
"""Interactive helper for inspecting the local RAG ETL pipeline."""

from __future__ import annotations

import argparse
import contextlib
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Iterable

import psycopg
import requests
from directus_py_sdk import DirectusClient
from dotenv import load_dotenv
from neo4j import GraphDatabase


def _load_env_files(extra_files: list[str] | None) -> None:
    candidates: list[Path] = []
    script_path = Path(__file__).resolve()
    candidates.append(script_path.parents[1] / ".env")
    candidates.append(script_path.parents[3] / "local.env")
    if extra_files:
        candidates.extend(Path(p) for p in extra_files)
    seen: set[Path] = set()
    for path in candidates:
        if not path:
            continue
        path = path.expanduser()
        if path in seen:
            continue
        if path.exists():
            load_dotenv(path, override=True)
        seen.add(path)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Environment variable {name} is required")
    return value


def _normalize_pg_dsn(url: str) -> str:
    if url.startswith("postgresql+psycopg://"):
        return "postgresql://" + url[len("postgresql+psycopg://") :]
    if url.startswith("postgresql://"):
        return url
    raise RuntimeError("DATABASE_URL must start with postgresql://")


def _format_dt(value: str | None) -> str:
    if not value:
        return "-"
    try:
        dt = datetime.fromisoformat(value.rstrip("Z")).astimezone(timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M:%S UTC")
    except ValueError:
        return value


def _format_ms(ms: int | None) -> str:
    if ms is None:
        return "-"
    seconds = ms / 1000
    if seconds < 1:
        return f"{seconds:.2f}s"
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes = seconds / 60
    return f"{minutes:.1f}m"


@dataclass
class SegmentRecord:
    segment_id: str
    chunk_ids: list[str]
    lightrag_flag: bool
    has_transcript: bool
    has_context: bool


class DirectusHelper:
    def __init__(self, client: DirectusClient) -> None:
        self._client = client

    def _paginate(self, collection: str, query: dict[str, Any], page_size: int = 200) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page = 1
        while True:
            payload = {"query": {**query, "limit": page_size, "page": page}}
            batch = self._client.get_items(collection, payload)
            if not batch:
                break
            items.extend(batch)
            if len(batch) < page_size:
                break
            page += 1
        return items

    def get_conversation(self, conversation_id: str) -> dict[str, Any]:
        return self._client.get_item("conversation", conversation_id)

    def get_chunks(self, conversation_id: str) -> list[dict[str, Any]]:
        query = {
            "filter": {"conversation_id": {"_eq": conversation_id}},
            "fields": [
                "id",
                "timestamp",
                "transcript",
                "path",
                "duration",
                "conversation_segments.conversation_segment_id",
            ],
            "sort": "timestamp",
        }
        return self._paginate("conversation_chunk", query)

    def get_segment_links(self, chunk_ids: Iterable[str]) -> list[dict[str, Any]]:
        ids = list(chunk_ids)
        if not ids:
            return []
        query = {
            "filter": {"conversation_chunk_id": {"_in": ids}},
            "fields": ["conversation_chunk_id", "conversation_segment_id"],
        }
        return self._paginate("conversation_segment_conversation_chunk", query)

    def get_segments(self, segment_ids: Iterable[int]) -> list[dict[str, Any]]:
        ids = list(segment_ids)
        if not ids:
            return []
        query = {
            "filter": {"id": {"_in": ids}},
            "fields": [
                "id",
                "lightrag_flag",
                "transcript",
                "contextual_transcript",
            ],
        }
        return self._paginate("conversation_segment", query)

    def get_processing_events(self, conversation_id: str, limit: int) -> list[dict[str, Any]]:
        payload = {
            "query": {
                "filter": {"conversation_id": conversation_id},
                "fields": ["event", "message", "duration_ms", "date_created"],
                "sort": ["-date_created"],
                "limit": limit,
            }
        }
        return self._client.get_items("processing_status", payload)

    def list_recent_conversations(
        self,
        *,
        limit: int,
        recent_minutes: int | None,
        only_unfinished: bool,
    ) -> list[dict[str, Any]]:
        filters: list[dict[str, Any]] = []
        if only_unfinished:
            filters.append({"is_audio_processing_finished": {"_eq": False}})
        if recent_minutes:
            threshold = datetime.utcnow() - timedelta(minutes=recent_minutes)
            filters.append({"date_created": {"_gte": threshold.isoformat() + "Z"}})

        query: dict[str, Any] = {
            "fields": [
                "id",
                "project_id",
                "participant_name",
                "date_created",
                "date_updated",
                "is_audio_processing_finished",
            ],
            "sort": ["-date_created"],
            "limit": limit,
        }
        if filters:
            if len(filters) == 1:
                query["filter"] = filters[0]
            else:
                query["filter"] = {"_and": filters}

        result = self._client.get_items("conversation", {"query": query})
        if not isinstance(result, list):
            return []
        return result


class RagInspector:
    def __init__(
        self,
        directus: DirectusClient,
        directus_token: str,
        pg_dsn: str,
        neo4j_uri: str,
        neo4j_user: str,
        neo4j_password: str,
        api_base_url: str,
    ) -> None:
        self.directus = DirectusHelper(directus)
        self.directus_token = directus_token
        self.pg_conn = psycopg.connect(pg_dsn, autocommit=True)
        self.neo4j_driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_password))
        self.api_base_url = api_base_url.rstrip("/")

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.pg_conn.close()
        with contextlib.suppress(Exception):
            self.neo4j_driver.close()

    def build_segment_catalog(self, chunk_rows: list[dict[str, Any]]) -> dict[str, SegmentRecord]:
        chunk_ids = [row["id"] for row in chunk_rows]
        mapping_rows = self.directus.get_segment_links(chunk_ids)
        segment_to_chunks: dict[str, list[str]] = {}
        for row in mapping_rows:
            seg_id = str(row.get("conversation_segment_id"))
            chk_id = row.get("conversation_chunk_id")
            if not seg_id or not chk_id:
                continue
            segment_to_chunks.setdefault(seg_id, []).append(chk_id)
        segments = self.directus.get_segments(int(seg) for seg in segment_to_chunks.keys())
        catalog: dict[str, SegmentRecord] = {}
        for row in segments:
            seg_id = str(row["id"])
            catalog[seg_id] = SegmentRecord(
                segment_id=seg_id,
                chunk_ids=sorted(segment_to_chunks.get(seg_id, [])),
                lightrag_flag=bool(row.get("lightrag_flag")),
                has_transcript=bool(row.get("transcript")),
                has_context=bool(row.get("contextual_transcript")),
            )
        return catalog

    def fetch_pg_counts(self, segment_ids: list[str]) -> dict[str, int]:
        if not segment_ids:
            return {}
        query = (
            "SELECT document_id, COUNT(*) FROM lightrag_vdb_transcript "
            "WHERE document_id = ANY(%s) GROUP BY document_id"
        )
        with self.pg_conn.cursor() as cur:
            cur.execute(query, (segment_ids,))
            rows = cur.fetchall()
        return {row[0]: int(row[1]) for row in rows}

    def fetch_neo4j_counts(self, segment_ids: list[str]) -> dict[str, int]:
        if not segment_ids:
            return {}
        query = (
            "MATCH (n:base) WHERE n.entity_id IN $ids "
            "RETURN n.entity_id AS entity_id, count(n) AS cnt"
        )
        result: dict[str, int] = {}
        with self.neo4j_driver.session() as session:
            records = session.run(query, ids=segment_ids)
            for record in records:
                entity_id = record["entity_id"]
                if entity_id is not None:
                    result[str(entity_id)] = int(record["cnt"])
        return result

    def fetch_api_counts(self, conversation_id: str) -> dict[str, Any] | None:
        try:
            response = requests.get(
                f"{self.api_base_url}/conversations/{conversation_id}/counts",
                timeout=5,
                headers={"Authorization": f"Bearer {self.directus_token}"},
            )
            if response.status_code == 200:
                return response.json()
            return {"error": f"{response.status_code}: {response.text}"}
        except Exception as exc:
            return {"error": str(exc)}

    def gather(self, conversation_id: str, status_limit: int) -> dict[str, Any]:
        conversation = self.directus.get_conversation(conversation_id)
        chunks = self.directus.get_chunks(conversation_id)
        segments = self.build_segment_catalog(chunks)
        segment_ids = sorted(segments.keys())
        pg_counts = self.fetch_pg_counts(segment_ids)
        neo4j_counts = self.fetch_neo4j_counts(segment_ids)
        processing = self.directus.get_processing_events(conversation_id, status_limit)
        api_counts = self.fetch_api_counts(conversation_id)
        return {
            "conversation": conversation,
            "chunks": chunks,
            "segments": segments,
            "pg_counts": pg_counts,
            "neo4j_counts": neo4j_counts,
            "processing_events": processing,
            "api_counts": api_counts,
        }

    def fetch_global_stats(self) -> dict[str, Any]:
        stats: dict[str, Any] = {}
        try:
            with self.pg_conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM conversation")
                stats["conversation_total"] = int(cur.fetchone()[0])
                cur.execute("SELECT count(*) FROM conversation_chunk")
                stats["chunk_total"] = int(cur.fetchone()[0])
                cur.execute("SELECT count(*) FROM conversation_segment")
                stats["segment_total"] = int(cur.fetchone()[0])
                cur.execute("SELECT count(*) FROM lightrag_vdb_transcript")
                stats["vector_total"] = int(cur.fetchone()[0])
        except Exception as exc:  # pragma: no cover - database connectivity issues
            stats["pg_error"] = str(exc)

        try:
            with self.neo4j_driver.session() as session:
                record = session.run("MATCH (n) RETURN count(n) AS cnt").single()
                stats["neo4j_nodes"] = int(record["cnt"]) if record else 0
        except Exception as exc:  # pragma: no cover - Neo4j connectivity issues
            stats["neo4j_error"] = str(exc)

        return stats


def _print_header(title: str) -> None:
    print("\n" + title)
    print("-" * len(title))


def _print_conversation(summary: dict[str, Any]) -> None:
    conv = summary["conversation"]
    print(f"Conversation ID : {conv.get('id')}")
    print(f"Project ID      : {conv.get('project_id')}")
    print(f"Participant     : {conv.get('participant_name')}")
    print(f"Created         : {_format_dt(conv.get('date_created'))}")
    print(f"Updated         : {_format_dt(conv.get('date_updated'))}")
    print(f"Audio finished  : {conv.get('is_audio_processing_finished')}")


def _print_chunks(summary: dict[str, Any]) -> None:
    rows = summary["chunks"]
    print(f"Total chunks    : {len(rows)}")
    with_audio = sum(1 for row in rows if row.get("path"))
    with_transcript = sum(1 for row in rows if row.get("transcript"))
    print(f"Chunks with audio path     : {with_audio}")
    print(f"Chunks with transcript     : {with_transcript}")


def _print_segments(summary: dict[str, Any]) -> None:
    segments: dict[str, SegmentRecord] = summary["segments"]
    pg_counts: dict[str, int] = summary["pg_counts"]
    neo4j_counts: dict[str, int] = summary["neo4j_counts"]
    print(f"Total segments  : {len(segments)}")
    lightrag_ready = [s for s in segments.values() if s.lightrag_flag]
    print(f"Segments flagged for LightRAG : {len(lightrag_ready)}")
    missing_context = [s.segment_id for s in segments.values() if not s.has_context]
    if missing_context:
        print("Segments missing contextual transcript:")
        for seg_id in missing_context[:10]:
            print(f"  - {seg_id}")
        if len(missing_context) > 10:
            print(f"  … {len(missing_context) - 10} more")
    missing_pg = [seg for seg in segments if pg_counts.get(seg, 0) == 0]
    missing_neo = [seg for seg in segments if neo4j_counts.get(seg, 0) == 0]
    print(f"Segments in PGVector        : {len(segments) - len(missing_pg)}")
    if missing_pg:
        print("  Missing in PGVector:")
        for seg in missing_pg[:10]:
            print(f"    - {seg}")
        if len(missing_pg) > 10:
            print(f"    … {len(missing_pg) - 10} more")
    print(f"Segments in Neo4j           : {len(segments) - len(missing_neo)}")
    if missing_neo:
        print("  Missing in Neo4j:")
        for seg in missing_neo[:10]:
            print(f"    - {seg}")
        if len(missing_neo) > 10:
            print(f"    … {len(missing_neo) - 10} more")


def _print_api_counts(summary: dict[str, Any]) -> None:
    info = summary.get("api_counts")
    if not info:
        return
    print("API counts endpoint:")
    if "error" in info:
        print(f"  error: {info['error']}")
        return
    for key, value in info.items():
        print(f"  {key}: {value}")


def _print_processing_events(summary: dict[str, Any]) -> None:
    events = summary["processing_events"]
    if not events:
        print("No processing_status entries found")
        return
    print("Latest processing_status events:")
    for event in events:
        timestamp = _format_dt(event.get("date_created"))
        duration = _format_ms(event.get("duration_ms"))
        name = event.get("event")
        message = (event.get("message") or "").strip()
        print(f"  [{timestamp}] {name} ({duration})")
        if message:
            print(f"    {message}")


def _render_report(summary: dict[str, Any]) -> None:
    _print_header("Conversation")
    _print_conversation(summary)
    _print_header("Chunks")
    _print_chunks(summary)
    _print_header("Segments")
    _print_segments(summary)
    _print_header("API Insight")
    _print_api_counts(summary)
    _print_header("Processing Timeline")
    _print_processing_events(summary)


def _render_global_stats(stats: dict[str, Any]) -> None:
    print("Connections")
    print("-----------")
    if "pg_error" in stats:
        print(f"PostgreSQL: ERROR - {stats['pg_error']}")
    else:
        print(
            "PostgreSQL: conversations={conversation_total} chunks={chunk_total} "
            "segments={segment_total} transcripts={vector_total}".format(
                conversation_total=stats.get("conversation_total", 0),
                chunk_total=stats.get("chunk_total", 0),
                segment_total=stats.get("segment_total", 0),
                vector_total=stats.get("vector_total", 0),
            )
        )

    if "neo4j_error" in stats:
        print(f"Neo4j: ERROR - {stats['neo4j_error']}")
    else:
        print(f"Neo4j: nodes={stats.get('neo4j_nodes', 0)}")

    print("Listening for new conversations and ETL updates...\n")


def _snapshot_summary(summary: dict[str, Any]) -> dict[str, Any]:
    segments: dict[str, SegmentRecord] = summary["segments"]
    pg_counts: dict[str, int] = summary["pg_counts"]
    neo_counts: dict[str, int] = summary["neo4j_counts"]
    events = summary["processing_events"]

    event_keys = []
    for event in events:
        event_keys.append((event.get("event", ""), event.get("date_created", "")))

    snapshot = {
        "chunk_count": len(summary["chunks"]),
        "segment_total": len(segments),
        "segment_flagged": sum(1 for seg in segments.values() if seg.lightrag_flag),
        "pg_total": sum(pg_counts.values()),
        "neo_total": sum(neo_counts.values()),
        "latest_event_ts": events[0].get("date_created") if events else None,
        "event_keys": frozenset(event_keys),
        "is_finished": bool(summary["conversation"].get("is_audio_processing_finished")),
    }
    return snapshot


def _diff_snapshots(previous: dict[str, Any] | None, current: dict[str, Any]) -> list[str]:
    if previous is None:
        messages = ["Initial snapshot captured."]
        if current["chunk_count"]:
            messages.append(f"Chunks observed: {current['chunk_count']}")
        if current["segment_total"]:
            messages.append(f"Segments tracked: {current['segment_total']}")
        return messages

    messages: list[str] = []

    def _format_delta(metric: str, label: str) -> None:
        prev_value = previous.get(metric, 0)
        curr_value = current.get(metric, 0)
        if curr_value != prev_value:
            delta = curr_value - prev_value
            sign = "" if delta < 0 else "+"
            messages.append(f"{label}: {prev_value} → {curr_value} ({sign}{delta})")

    _format_delta("chunk_count", "Chunk count")
    _format_delta("segment_total", "Segments discovered")
    _format_delta("segment_flagged", "Segments flagged for LightRAG")
    _format_delta("pg_total", "Vector transcripts")
    _format_delta("neo_total", "Neo4j nodes")

    new_events = current["event_keys"] - previous.get("event_keys", frozenset())
    if new_events:
        for event_name, ts in sorted(new_events, key=lambda item: item[1]):
            if event_name:
                messages.append(f"New event: {event_name} @ {ts}")
            else:
                messages.append(f"New processing event recorded @ {ts}")

    if previous.get("is_finished") != current.get("is_finished"):
        state = "COMPLETED" if current.get("is_finished") else "IN PROGRESS"
        messages.append(f"Audio processing state changed → {state}")

    return messages


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect local RAG ETL state")
    parser.add_argument("--conversation-id", dest="conversation_id", help="Conversation UUID to inspect")
    parser.add_argument("--env-file", dest="env_files", action="append", help="Additional .env files")
    parser.add_argument("--interval", type=float, default=15.0, help="Refresh interval in seconds")
    parser.add_argument("--once", action="store_true", help="Run one inspection and exit")
    parser.add_argument("--status-limit", type=int, default=15, help="Number of processing_status events to display")
    parser.add_argument("--auto", action="store_true", help="Continuously watch for new conversations")
    parser.add_argument("--limit", type=int, default=5, help="Max conversations to display in auto mode")
    parser.add_argument(
        "--recent-minutes",
        type=int,
        default=240,
        help="Only consider conversations created within this window (auto mode)",
    )
    parser.add_argument(
        "--only-unfinished",
        action="store_true",
        help="Auto mode: focus on conversations where is_audio_processing_finished is false",
    )
    parser.add_argument(
        "--keep-finished",
        action="store_true",
        help="Auto mode: retain conversations even after they finish",
    )
    parser.add_argument("--no-clear", action="store_true", help="Do not clear the screen between refreshes")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    _load_env_files(args.env_files)

    directus_base = _require_env("DIRECTUS_BASE_URL")
    directus_token = _require_env("DIRECTUS_TOKEN")
    api_base_url = os.environ.get("API_BASE_URL", "http://localhost:8000/api")
    database_url = _normalize_pg_dsn(_require_env("DATABASE_URL"))
    neo4j_uri = _require_env("NEO4J_URI")
    neo4j_user = _require_env("NEO4J_USERNAME")
    neo4j_password = _require_env("NEO4J_PASSWORD")

    client = DirectusClient(url=directus_base, token=directus_token)
    inspector = RagInspector(
        directus=client,
        directus_token=directus_token,
        pg_dsn=database_url,
        neo4j_uri=neo4j_uri,
        neo4j_user=neo4j_user,
        neo4j_password=neo4j_password,
        api_base_url=api_base_url,
    )

    def _clear_screen() -> None:
        if not args.no_clear:
            os.system("clear")

    try:
        if args.auto:
            refresh_interval = args.interval if args.interval > 0 else 15.0
            overview: dict[str, dict[str, Any]] = {}
            seen: set[str] = set()
            last_error: str | None = None
            snapshots: dict[str, dict[str, Any]] = {}

            while True:
                stats = inspector.fetch_global_stats()
                try:
                    recent = inspector.directus.list_recent_conversations(
                        limit=max(args.limit if args.limit > 0 else 20, 1),
                        recent_minutes=args.recent_minutes,
                        only_unfinished=args.only_unfinished,
                    )
                    last_error = None
                except Exception as exc:  # pragma: no cover - network/Directus errors
                    recent = []
                    last_error = str(exc)

                for meta in recent:
                    conv_id = meta.get("id")
                    if conv_id:
                        overview.setdefault(conv_id, {})
                        overview[conv_id].update(meta)

                if args.conversation_id:
                    overview.setdefault(args.conversation_id, {"id": args.conversation_id})

                if not overview:
                    _clear_screen()
                    print(f"RAG ETL Observer — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                    _render_global_stats(stats)
                    if last_error:
                        print(f"Error fetching conversations: {last_error}")
                    else:
                        print("No conversations match the current filters.")
                    if args.once:
                        return 0
                    time.sleep(refresh_interval)
                    continue

                sorted_meta = sorted(
                    overview.values(),
                    key=lambda data: data.get("date_created", ""),
                    reverse=True,
                )

                display_ids: list[str] = []
                for meta in sorted_meta:
                    conv_id = meta.get("id")
                    if not conv_id:
                        continue
                    if args.limit > 0 and len(display_ids) >= args.limit:
                        break
                    display_ids.append(conv_id)

                if args.conversation_id and args.conversation_id not in display_ids and args.conversation_id in overview:
                    display_ids.append(args.conversation_id)

                _clear_screen()
                print(f"RAG ETL Observer — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                _render_global_stats(stats)
                if last_error:
                    print(f"Warning: {last_error}\n")

                if not display_ids:
                    print("No conversations available for display (consider adjusting --limit or filters).")
                else:
                    to_remove: set[str] = set()
                    total = len(display_ids)
                    for idx, conv_id in enumerate(display_ids, start=1):
                        try:
                            summary = inspector.gather(conv_id, status_limit=args.status_limit)
                        except Exception as exc:  # pragma: no cover - network errors
                            print(f"[{idx}/{total}] Conversation {conv_id}: error {exc}\n")
                            continue

                        overview[conv_id] = summary["conversation"]
                        participant = summary["conversation"].get("participant_name") or "-"
                        marker = " [NEW]" if conv_id not in seen else ""
                        seen.add(conv_id)

                        print("=" * 80)
                        print(f"[{idx}/{total}] Conversation {conv_id}{marker} — participant: {participant}")
                        _render_report(summary)

                        snapshot = _snapshot_summary(summary)
                        changes = _diff_snapshots(snapshots.get(conv_id), snapshot)
                        if changes:
                            print("Updates since last refresh:")
                            for change in changes:
                                print(f"  - {change}")
                        else:
                            print("Updates since last refresh: no changes detected.")
                        snapshots[conv_id] = snapshot

                        if not args.keep_finished and summary["conversation"].get("is_audio_processing_finished"):
                            to_remove.add(conv_id)

                        if idx != total:
                            print()

                    for conv_id in to_remove:
                        overview.pop(conv_id, None)
                        snapshots.pop(conv_id, None)

                    keep_ids = set(display_ids)
                    if args.conversation_id and args.conversation_id in overview:
                        keep_ids.add(args.conversation_id)
                    for conv_id in list(overview.keys()):
                        if conv_id not in keep_ids:
                            overview.pop(conv_id, None)
                            snapshots.pop(conv_id, None)

                if args.once:
                    return 0

                time.sleep(refresh_interval)
        else:
            conversation_id = args.conversation_id or input("Conversation ID: ").strip()
            if not conversation_id:
                print("Conversation ID is required", file=sys.stderr)
                return 1

            interactive = args.interval <= 0
            previous_snapshot: dict[str, Any] | None = None
            while True:
                summary = inspector.gather(conversation_id, status_limit=args.status_limit)
                _clear_screen()
                print(f"RAG ETL Observer — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                stats = inspector.fetch_global_stats()
                _render_global_stats(stats)
                _render_report(summary)
                snapshot = _snapshot_summary(summary)
                changes = _diff_snapshots(previous_snapshot, snapshot)
                if changes:
                    print("Updates since last refresh:")
                    for change in changes:
                        print(f"  - {change}")
                previous_snapshot = snapshot

                if args.once:
                    return 0

                if interactive:
                    user_input = input("\nPress Enter to refresh, 'q' to quit, or provide new conversation ID: ").strip()
                    if user_input.lower() in {"q", "quit", "exit"}:
                        return 0
                    if user_input:
                        conversation_id = user_input
                else:
                    time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0
    finally:
        inspector.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
