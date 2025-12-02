"""
Dembrane ECHO Usage Tracker

A customer usage reporting tool for sales teams.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import math
import random
import statistics

import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

IGNORED_LLM_EMAILS = {
    "reach.usamazafar@gmail.com",
    "runpod_views@dembrane.com",
}

# Import our modules
try:
    from src.usage_tracker.settings import get_settings
    from src.usage_tracker.directus_client import (
        DirectusClient,
        DirectusError,
        DirectusConnectionError,
        DirectusAuthError,
    )
    from src.usage_tracker.data_fetcher import (
        DataFetcher,
        DateRange,
        UserInfo,
        UserUsageData,
    )
    from src.usage_tracker.metrics import (
        calculate_metrics,
        calculate_trends,
        get_period_comparison,
        UsageMetrics,
        MonthlyStats,
        format_duration,
        estimate_conversation_duration,
    )
    from src.usage_tracker.llm_insights import (
        generate_insights,
        generate_executive_summary,
        analyze_chat_messages,
        generate_monthly_overview,
        MonthlyOverviewPayload,
    )
    from src.usage_tracker.pdf_export import generate_pdf_report
except ImportError as e:
    st.error(f"Failed to import modules: {e}")
    st.info(
        "Make sure you're running from the usage-tracker directory with `uv run streamlit run app.py`"
    )
    st.stop()


# Page config
st.set_page_config(
    page_title="ECHO Usage Tracker",
    page_icon="📊",
    layout="wide",
    initial_sidebar_state="expanded",
)

# Custom CSS
st.markdown(
    """
    <style>
    .main-header {
        font-size: 2.5rem;
        font-weight: 700;
        color: #1a1a2e;
        margin-bottom: 0.5rem;
    }
    .sub-header {
        font-size: 1rem;
        color: #666;
        margin-bottom: 2rem;
    }
    .metric-card {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        padding: 1.5rem;
        border-radius: 12px;
        color: white;
    }
    .metric-value {
        font-size: 2rem;
        font-weight: 700;
    }
    .metric-label {
        font-size: 0.9rem;
        opacity: 0.9;
    }
    .stTabs [data-baseweb="tab-list"] {
        gap: 24px;
    }
    .stTabs [data-baseweb="tab"] {
        height: 50px;
        padding: 0 24px;
        background-color: transparent;
        border-radius: 8px 8px 0 0;
    }
    </style>
    """,
    unsafe_allow_html=True,
)


def _is_ignored_email(email: Optional[str]) -> bool:
    return bool(email and email.lower() in IGNORED_LLM_EMAILS)


def _percentile(sorted_values: List[float], percentile: float) -> float:
    """Calculate percentile (0-1) for a sorted list."""
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    k = (len(sorted_values) - 1) * percentile
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return float(sorted_values[int(k)])
    d0 = sorted_values[f] * (c - k)
    d1 = sorted_values[c] * (k - f)
    return float(d0 + d1)


def _build_conversation_spread_insight(project_activity: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """Summarize how conversations are distributed across projects."""
    counts = [
        entry.get("conversations", 0)
        for entry in project_activity.values()
        if entry.get("conversations", 0) > 0
    ]
    if not counts:
        return {
            "summary": "No conversation activity recorded for this window.",
            "bullets": [],
        }

    counts.sort()
    median_val = statistics.median(counts)
    p90_val = _percentile(counts, 0.9)
    total = sum(counts)
    top3 = sum(sorted(counts, reverse=True)[:3])
    share = (top3 / total) if total else 0.0
    heaviest = counts[-1]
    spread = heaviest / median_val if median_val else heaviest

    bullets = [
        f"P90 sits at {p90_val:.1f} conversations which is {p90_val / median_val:.1f}× the median.",
        f"Top 3 projects absorb {share:.0%} of conversations ({top3} of {total}).",
        f"Heaviest single project logs {heaviest} convs ({spread:.1f}× the median throughput).",
    ]

    return {
        "summary": f"{len(counts)} projects were active · median {median_val:.1f} convs/project.",
        "bullets": bullets,
    }


def _build_login_baseline_insight(
    login_summary: Dict[str, Dict[str, Any]],
    range_days: int,
) -> Dict[str, Any]:
    """Estimate baseline login expectations."""
    if not login_summary:
        return {
            "summary": "No login activity captured for this window.",
            "bullets": [],
        }

    total_logins = sum(entry.get("count", 0) for entry in login_summary.values())
    unique_users = len(login_summary)
    avg_per_user = total_logins / unique_users if unique_users else 0.0
    median_logins = statistics.median([entry.get("count", 0) for entry in login_summary.values()])
    weeks = max(range_days / 7, 1)
    avg_per_week = total_logins / weeks

    heavy_users = sum(
        1
        for entry in login_summary.values()
        if (entry.get("count", 0) / weeks) > 8
    )

    bullets = [
        f"Mean logins/user: {avg_per_user:.1f} · median: {median_logins:.1f}.",
        f"Team averages {avg_per_week:.1f} total logins/week across the cohort.",
        f"{heavy_users} user(s) exceed the power-user bar (>8 logins/week).",
    ]

    return {
        "summary": f"{unique_users} users generated {total_logins} logins ({avg_per_user:.1f} each).",
        "bullets": bullets,
    }


def _build_shared_account_insight(
    login_summary: Dict[str, Dict[str, Any]],
    login_daily_by_user: Dict[str, Dict[date, int]],
    user_lookup: Dict[str, "UserInfo"],
) -> Dict[str, Any]:
    """Identify accounts averaging more than one login per active day."""
    flagged = []
    for user_id, stats in login_summary.items():
        if not user_id:
            continue
        daily_counts = login_daily_by_user.get(user_id, {})
        if not daily_counts:
            continue
        active_days = len(daily_counts)
        if active_days == 0:
            continue
        total_logins = stats.get("count", 0)
        avg_per_day = total_logins / active_days
        multi_days = sum(1 for count in daily_counts.values() if count > 1)
        peak = max(daily_counts.values())
        if avg_per_day <= 1.0 and peak <= 1:
            continue
        info = user_lookup.get(user_id)
        flagged.append(
            {
                "name": info.display_name if info else user_id,
                "email": (info.email or "—") if info else "—",
                "avg_per_day": avg_per_day,
                "peak": peak,
                "multi_ratio": multi_days / active_days,
            }
        )

    if not flagged:
        return {
            "summary": "No accounts averaged more than 1 login/day.",
            "bullets": [],
        }

    flagged.sort(key=lambda item: item["avg_per_day"], reverse=True)
    bullets = []
    for entry in flagged[:3]:
        bullets.append(
            f"{entry['name']} ({entry['email']}) averages {entry['avg_per_day']:.1f} logins/day; "
            f"peak day = {entry['peak']} sessions."
        )
    if len(flagged) > 3:
        bullets.append(f"{len(flagged) - 3} additional account(s) also sit above 1 login/day.")

    return {
        "summary": f"{len(flagged)} account(s) routinely exceed 1 login/day.",
        "bullets": bullets,
    }


@st.cache_data(ttl=300)
def fetch_dashboard_usage_samples(
    _client: DirectusClient,
    user_ids: Tuple[str, ...],
    date_range_start: Optional[date],
    date_range_end: Optional[date],
) -> List[UserUsageData]:
    """Fetch a limited set of usage records for dashboard-wide sampling."""
    if not user_ids:
        return []
    fetcher = DataFetcher(_client)
    date_range = None
    if date_range_start and date_range_end:
        date_range = DateRange(date_range_start, date_range_end)
    return fetcher.get_multi_user_usage_data(list(user_ids), date_range)


def _select_chat_segments(login_summary: Dict[str, Dict[str, Any]]) -> Dict[str, List[str]]:
    """Group users into cohorts for stratified chat sampling."""
    ordered_ids = [
        user_id
        for user_id, entry in sorted(
            login_summary.items(),
            key=lambda item: item[1].get("count", 0),
            reverse=True,
        )
        if user_id
    ]
    if not ordered_ids:
        return {}

    segments: Dict[str, List[str]] = {}
    if ordered_ids:
        segments["Power researchers"] = ordered_ids[:4]
    if len(ordered_ids) > 4:
        segments["Steady operators"] = ordered_ids[4:8]
    if len(ordered_ids) > 8:
        segments["Occasional testers"] = ordered_ids[8:12]
    return {label: ids for label, ids in segments.items() if ids}


def _build_chat_segment_samples(
    client: DirectusClient,
    segments: Dict[str, List[str]],
    date_range: Optional[DateRange],
    user_lookup: Dict[str, "UserInfo"],
) -> Dict[str, List[str]]:
    """Load chat text samples per cohort."""
    if not segments:
        return {}

    unique_ids = tuple(sorted({uid for ids in segments.values() for uid in ids}))
    if not unique_ids:
        return {}

    date_start = date_range.start if date_range else None
    date_end = date_range.end if date_range else None
    usage_samples = fetch_dashboard_usage_samples(client, unique_ids, date_start, date_end)
    usage_lookup = {ud.user.id: ud for ud in usage_samples}

    segment_samples: Dict[str, List[str]] = {}
    for segment_name, user_ids in segments.items():
        bucket: List[str] = []
        for user_id in user_ids:
            usage = usage_lookup.get(user_id)
            if not usage:
                continue
            info = user_lookup.get(user_id)
            if info and _is_ignored_email(info.email):
                continue
            user_texts = [
                (msg.text or "").strip()
                for msg in usage.chat_messages
                if msg.message_from and msg.message_from.lower() == "user" and msg.text
            ]
            if not user_texts:
                continue
            sample_size = min(len(user_texts), 40)
            if len(user_texts) > sample_size:
                bucket.extend(random.sample(user_texts, sample_size))
            else:
                bucket.extend(user_texts)
        if bucket:
            segment_samples[segment_name] = bucket
    return segment_samples


def _chat_trend_pipeline(
    client: DirectusClient,
    login_summary: Dict[str, Dict[str, Any]],
    user_lookup: Dict[str, "UserInfo"],
    date_range: Optional[DateRange],
) -> Dict[str, Any]:
    """Run stratified chat sampling and call the LLM for emerging trends."""
    from src.usage_tracker.llm_insights import analyze_stratified_chat_segments

    segments = _select_chat_segments(login_summary)
    segment_samples = _build_chat_segment_samples(client, segments, date_range, user_lookup)

    if not segment_samples:
        return {
            "summary": "Not enough chat depth to analyze cohort trends.",
            "details_markdown": None,
        }

    insight = analyze_stratified_chat_segments(
        segment_samples,
        ignored_accounts=sorted(IGNORED_LLM_EMAILS),
    )
    return {
        "summary": f"Analyzed chat cohorts: {', '.join(segment_samples.keys())}.",
        "details_markdown": insight,
    }


def _execute_insight_pipelines(pipelines: List[Tuple[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Run multiple insight builders concurrently and report progress."""
    if not pipelines:
        return {}

    status_box = st.empty()
    progress_bar = st.progress(
        0.0,
        text=f"Running {len(pipelines)} insight pipelines in parallel...",
    )

    statuses = {name: "queued" for name, _ in pipelines}

    def render_status() -> None:
        lines = [f"- **{name}** · {statuses[name]}" for name in statuses]
        status_box.markdown("\n".join(lines))

    render_status()

    results: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=len(pipelines)) as executor:
        future_to_name = {}
        for name, func in pipelines:
            statuses[name] = "running"
            render_status()
            future = executor.submit(func)
            future_to_name[future] = name

        completed = 0
        for future in as_completed(future_to_name):
            name = future_to_name[future]
            try:
                results[name] = future.result()
                statuses[name] = "✅ done"
            except Exception as exc:  # noqa: BLE001
                logger.exception("Pipeline %s failed", name)
                results[name] = {
                    "summary": f"⚠️ Failed to compute: {exc}",
                    "bullets": [],
                }
                statuses[name] = "⚠️ failed"
            completed += 1
            pending = [n for n, status in statuses.items() if status == "running"]
            progress_bar.progress(
                completed / len(pipelines),
                text=(
                    f"Finished {completed}/{len(pipelines)} pipelines · "
                    f"Pending: {', '.join(pending) if pending else '—'}"
                ),
            )
            render_status()

    progress_bar.progress(1.0, text="Insight pipelines complete")

    ordered_results: Dict[str, Dict[str, Any]] = {}
    for name, _ in pipelines:
        ordered_results[name] = results.get(
            name,
            {"summary": "No data", "bullets": []},
        )
    return ordered_results


def render_dashboard_insight_pipelines(
    client: DirectusClient,
    login_summary: Dict[str, Dict[str, Any]],
    project_activity: Dict[str, Dict[str, Any]],
    login_daily_by_user: Dict[str, Dict[date, int]],
    user_lookup: Dict[str, "UserInfo"],
    selected_range: Optional[DateRange],
    range_days: int,
):
    """Display asynchronous insight pipelines on the dashboard."""
    st.subheader("Insight Pipelines")
    cache_key = f"dashboard_pipelines_{_dashboard_cache_key(selected_range)}"

    rerun = st.button(
        "Re-run insight pipelines",
        key=f"rerun_pipelines_{cache_key}",
        help="Refresh derived trends using the latest data.",
    )
    if rerun and cache_key in st.session_state:
        del st.session_state[cache_key]

    if cache_key not in st.session_state:
        pipelines = [
            (
                "Conversation spread",
                lambda: _build_conversation_spread_insight(project_activity),
            ),
            (
                "Login baseline",
                lambda: _build_login_baseline_insight(login_summary, range_days),
            ),
            (
                "Shared account checks",
                lambda: _build_shared_account_insight(
                    login_summary,
                    login_daily_by_user,
                    user_lookup,
                ),
            ),
            (
                "Chat trend scan",
                lambda: _chat_trend_pipeline(
                    client,
                    login_summary,
                    user_lookup,
                    selected_range,
                ),
            ),
        ]
        st.session_state[cache_key] = _execute_insight_pipelines(pipelines)

    results = st.session_state.get(cache_key, {})
    for name, result in results.items():
        summary_text = result.get("summary") or "No summary available."
        st.markdown(f"**{name}** — {summary_text}")
        for bullet in result.get("bullets", []):
            st.write(f"- {bullet}")
        details = result.get("details_markdown")
        if details:
            st.markdown(details)
        st.divider()


def get_date_ranges() -> dict:
    """Get predefined date ranges."""
    today = date.today()

    # Month to date
    mtd_start = today.replace(day=1)

    # Year to date
    ytd_start = today.replace(month=1, day=1)

    # Last 30 days
    last_30_start = today - timedelta(days=30)

    # Last 90 days
    last_90_start = today - timedelta(days=90)

    return {
        "All Time": None,
        "Month to Date (MTD)": DateRange(mtd_start, today),
        "Year to Date (YTD)": DateRange(ytd_start, today),
        "Last 30 Days": DateRange(last_30_start, today),
        "Last 90 Days": DateRange(last_90_start, today),
        "Custom Range": None,
    }


@st.cache_resource
def get_directus_client() -> Optional[DirectusClient]:
    """Get a cached Directus client."""
    try:
        settings = get_settings()
        client = DirectusClient(
            base_url=settings.directus.base_url,
            token=settings.directus.token,
        )
        # Test connection
        if client.test_connection():
            return client
        else:
            st.error("Failed to connect to Directus")
            return None
    except Exception as e:
        st.error(f"Failed to initialize Directus client: {e}")
        return None


@st.cache_data(ttl=300)  # Cache for 5 minutes
def fetch_all_users(_client: DirectusClient) -> List[UserInfo]:
    """Fetch all users from Directus."""
    fetcher = DataFetcher(_client)
    return fetcher.get_all_users()


def fetch_user_data_with_progress(
    client: DirectusClient,
    user_ids: List[str],
    date_range: Optional[DateRange],
) -> List[UserUsageData]:
    """Fetch usage data with live progress updates."""
    fetcher = DataFetcher(client)
    results = []
    total_users = len(user_ids)

    # Create a placeholder for progress
    progress_container = st.container()
    
    with progress_container:
        progress_bar = st.progress(0)
        status_text = st.empty()

        for i, user_id in enumerate(user_ids):
            # Per-user progress callback
            def user_progress(current: int, total: int, message: str) -> None:
                # Calculate overall progress: user progress + sub-step progress
                user_base = i / total_users
                user_increment = (1 / total_users) * (current / max(total, 1))
                overall = user_base + user_increment
                progress_bar.progress(min(overall, 1.0))
                status_text.text(f"User {i + 1}/{total_users}: {message}")

            user_progress(0, 6, "Starting...")
            data = fetcher.get_user_usage_data(user_id, date_range, progress=user_progress)
            if data:
                results.append(data)

        # Complete
        progress_bar.progress(1.0)
        status_text.text(f"✓ Loaded data for {len(results)} users")

    # Clear progress after a moment
    import time
    time.sleep(0.5)
    progress_container.empty()

    return results


# Keep cached version for trend comparisons (no progress needed)
@st.cache_data(ttl=60)
def fetch_user_data_cached(
    _client: DirectusClient,
    user_ids: Tuple[str, ...],
    date_range_start: Optional[date],
    date_range_end: Optional[date],
) -> List[UserUsageData]:
    """Fetch usage data for selected users (cached, no progress)."""
    fetcher = DataFetcher(_client)

    date_range = None
    if date_range_start and date_range_end:
        date_range = DateRange(date_range_start, date_range_end)

    return fetcher.get_multi_user_usage_data(list(user_ids), date_range)


def _format_delta(trend: tuple) -> Optional[str]:
    """Format trend delta with correct sign for Streamlit metric."""
    pct, direction = trend
    if direction == "flat":
        return None
    # Negative value shows red/down, positive shows green/up
    sign = -1 if direction == "down" else 1
    return f"{sign * pct:.1f}%"


def render_metric_cards(metrics: UsageMetrics, trends: dict):
    """Render the main metric cards - stock dashboard style."""
    cols = st.columns(5)

    with cols[0]:
        st.metric(
            "Projects",
            metrics.projects.total_projects,
            delta=_format_delta(trends.get("projects", (0, "flat"))),
        )
        if metrics.projects.total_projects > 0:
            avg_conv = metrics.projects.avg_conversations_per_project
            p90_conv = metrics.projects.p90_conversations_per_project
            st.caption(
                f"Avg {avg_conv:.1f} conv/project · P90 {p90_conv:.0f} conv"
            )

    with cols[1]:
        st.metric(
            "Conversations",
            metrics.audio.total_conversations,
            delta=_format_delta(trends.get("conversations", (0, "flat"))),
        )
        st.caption(f"⏱ Avg {metrics.audio.avg_duration_formatted} each")

    with cols[2]:
        st.metric(
            "Total Duration",
            metrics.audio.total_duration_formatted,
            delta=_format_delta(trends.get("duration", (0, "flat"))),
        )
        st.caption(f"P50 {metrics.audio.p50_duration_formatted} · P90 {metrics.audio.p90_duration_formatted}")

    with cols[3]:
        st.metric(
            "Chat Sessions",
            metrics.chat.total_chats,
            delta=_format_delta(trends.get("chats", (0, "flat"))),
        )
        if metrics.chat.total_chats > 0:
            avg_msgs = metrics.chat.total_messages / metrics.chat.total_chats
            st.caption(f"💬 {metrics.chat.user_messages} queries · {avg_msgs:.0f} msg/session")

    with cols[4]:
        st.metric(
            "Reports",
            metrics.reports.total_reports,
            delta=_format_delta(trends.get("reports", (0, "flat"))),
        )
        if metrics.reports.total_reports > 0:
            st.caption(f"✓ {metrics.reports.published_reports} published")


def render_login_tier_banner(metrics: UsageMetrics):
    """Show login usage tier beneath the main metric cards."""
    login_metrics = metrics.logins
    legend = "Power >8/wk · High 5-8 · Medium 1-5 · Low <1"

    if login_metrics.total_logins == 0:
        st.caption(f"Login tier: no recorded logins · {legend}")
        return

    tier = login_metrics.usage_band.title() if login_metrics.usage_band else "Unknown"
    avg_week = login_metrics.avg_logins_per_week
    st.caption(
        f"Login tier: **{tier}** ({avg_week:.1f} logins/week) · {legend}"
    )


def render_login_activity(metrics: UsageMetrics, users: List[UserInfo]):
    """Render login activity summary and chart."""
    login_metrics = metrics.logins

    st.subheader("🔐 Login Activity")

    if login_metrics.total_logins == 0:
        st.info("No login events recorded for this selection.")
        return

    cols = st.columns(4)
    with cols[0]:
        st.metric("Total Logins", login_metrics.total_logins)
    with cols[1]:
        st.metric("Active Days", login_metrics.unique_days)
    with cols[2]:
        st.metric("Unique Users", login_metrics.unique_users)
    with cols[3]:
        if login_metrics.last_login:
            st.metric("Last Login", login_metrics.last_login.strftime("%b %d, %Y %H:%M"))
        else:
            st.metric("Last Login", "—")

    st.caption(
        f"Avg {login_metrics.avg_logins_per_active_day:.1f} logins per active day · "
        f"Avg {login_metrics.avg_logins_per_user:.1f} per user · "
        f"{login_metrics.avg_logins_per_week:.1f} per week"
    )

    # Daily login chart
    if login_metrics.daily_logins:
        dates = sorted(login_metrics.daily_logins.keys())
        df = pd.DataFrame(
            {
                "date": dates,
                "logins": [login_metrics.daily_logins[d] for d in dates],
            }
        )

        user_lookup = {u.id: u.display_name for u in users}

        if len(users) > 1 and login_metrics.daily_logins_by_user:
            rows = []
            for user_id, counts in login_metrics.daily_logins_by_user.items():
                label = user_lookup.get(user_id, user_id)
                for day, count in counts.items():
                    rows.append({"date": day, "user": label, "logins": count})
            if rows:
                multi_df = pd.DataFrame(rows)
                multi_df.sort_values("date", inplace=True)
                fig = px.area(
                    multi_df,
                    x="date",
                    y="logins",
                    color="user",
                    line_group="user",
                    title="Logins per Day by User",
                )
                fig.update_layout(margin=dict(t=60, b=40))
                st.plotly_chart(fig, use_container_width=True)
            else:
                fig = px.bar(df, x="date", y="logins", title="Logins per Day")
                fig.update_layout(margin=dict(t=40, b=40))
                st.plotly_chart(fig, use_container_width=True)
        else:
            fig = px.bar(df, x="date", y="logins", title="Logins per Day")
            fig.update_layout(margin=dict(t=40, b=40))
            st.plotly_chart(fig, use_container_width=True)

    per_user = sorted(
        login_metrics.logins_by_user.items(), key=lambda item: item[1], reverse=True
    )
    if per_user:
        lookup = {u.id: u.display_name for u in users}
        summary_df = pd.DataFrame(
            [
                {"User": lookup.get(user_id, user_id), "Logins": count}
                for user_id, count in per_user
            ]
        )
        st.dataframe(summary_df, use_container_width=True, hide_index=True)


def _dashboard_cache_key(date_range: Optional[DateRange]) -> str:
    if date_range:
        return f"dashboard_summary_{date_range.start}_{date_range.end}"
    return "dashboard_summary_all_time"


def _get_dashboard_summary(
    client: DirectusClient, date_range: Optional[DateRange]
) -> Dict[str, Any]:
    """Fetch and cache leaderboard summaries for the dashboard view."""
    cache_key = _dashboard_cache_key(date_range)
    if cache_key in st.session_state:
        return st.session_state[cache_key]

    fetcher = DataFetcher(client)
    with st.status("Loading leaderboard data...", expanded=True) as status:
        try:
            status.update(label="Fetching login activity", state="running")
            login_events = fetcher.get_login_activity_events(
                user_ids=None,
                date_range=date_range,
            )
            login_per_user: Dict[str, Dict[str, Any]] = {}
            login_daily_by_user: Dict[str, Dict[date, int]] = defaultdict(lambda: defaultdict(int))
            daily_login_sets: Dict[date, set] = defaultdict(set)
            for event in login_events:
                if not event.user_id:
                    continue
                entry = login_per_user.setdefault(
                    event.user_id, {"count": 0, "last": None, "first": None}
                )
                entry["count"] += 1
                if event.timestamp:
                    if entry["last"] is None or event.timestamp > entry["last"]:
                        entry["last"] = event.timestamp
                    if entry["first"] is None or event.timestamp < entry["first"]:
                        entry["first"] = event.timestamp
                    day = event.timestamp.date()
                    login_daily_by_user[event.user_id][day] += 1
                    daily_login_sets[event.timestamp.date()].add(event.user_id)

            daily_login_counts = {day: len(users) for day, users in daily_login_sets.items()}
            status.write("✔ Login events aggregated")

            status.update(label="Aggregating conversations", state="running")
            conversation_snapshot = fetcher.get_conversation_activity_snapshot(date_range)
            project_activity = conversation_snapshot.get("per_project", {})

            status.update(label="Aggregating chat sessions", state="running")
            chat_summary = fetcher.get_project_chat_activity_summary(date_range)
            for proj_id, chat_data in chat_summary.items():
                entry = project_activity.setdefault(
                    proj_id,
                    {
                        "project_id": proj_id,
                        "project_name": chat_data.get("name") or f"Project {proj_id}",
                        "owner_id": chat_data.get("owner_id"),
                        "conversations": 0,
                        "last_conversation": None,
                        "chat_sessions": 0,
                        "last_chat": None,
                    },
                )
                entry["project_name"] = entry.get("project_name") or chat_data.get("name")
                if not entry.get("owner_id"):
                    entry["owner_id"] = chat_data.get("owner_id")
                entry["chat_sessions"] = chat_data.get("count", 0)
                last_chat = chat_data.get("last")
                if last_chat and (
                    entry["last_chat"] is None or last_chat > entry["last_chat"]
                ):
                    entry["last_chat"] = last_chat

            summary = {
                "logins": {
                    "per_user": login_per_user,
                    "daily": daily_login_counts,
                    "per_user_daily": login_daily_by_user,
                },
                "conversations": conversation_snapshot.get("per_user", {}),
                "projects": project_activity,
                "daily_conversations": conversation_snapshot.get("daily_conversations", {}),
                "daily_projects": conversation_snapshot.get("daily_projects", {}),
            }
            st.session_state[cache_key] = summary
            status.update(label="Leaderboard data ready", state="complete")
            return summary
        except Exception as exc:  # noqa: BLE001
            status.update(label="Failed to load leaderboard data", state="error")
            logger.exception("Failed to load dashboard summary")
            raise RuntimeError("Dashboard summary fetch failed") from exc


def _format_ts(ts: Optional[datetime]) -> str:
    if not ts:
        return "—"
    return ts.strftime("%b %d, %Y %H:%M")


def render_power_user_dashboard(
    client: DirectusClient,
    all_users: List[UserInfo],
    selected_range: Optional[DateRange],
):
    """Render default view showing leaderboards when no users are selected."""
    today = date.today()
    dashboard_range = selected_range

    try:
        summary = _get_dashboard_summary(client, dashboard_range)
    except RuntimeError as exc:
        st.error(f"Unable to load leaderboard data: {exc}")
        return

    login_section = summary.get("logins", {})
    login_summary = login_section.get("per_user", {})
    daily_logins = login_section.get("daily", {})
    login_daily_by_user = login_section.get("per_user_daily", {})
    conversation_summary = summary.get("conversations", {})
    project_activity = summary.get("projects", {})
    daily_conversations = summary.get("daily_conversations", {})
    daily_projects = summary.get("daily_projects", {})
    user_lookup = {u.id: u for u in all_users}

    st.info(
        "Pick users from the leaderboards below or use the sidebar to analyze a specific cohort."
    )
    if dashboard_range:
        range_label = (
            f"{dashboard_range.start.strftime('%b %d, %Y')} – "
            f"{dashboard_range.end.strftime('%b %d, %Y')}"
        )
        range_days = (dashboard_range.end - dashboard_range.start).days + 1
        latest_day = dashboard_range.end
    else:
        range_label = "All Time"
        timestamps = []
        for data in login_summary.values():
            if data.get("first"):
                timestamps.append(data["first"])
            if data.get("last"):
                timestamps.append(data["last"])
        if timestamps:
            range_days = max((max(timestamps) - min(timestamps)).days + 1, 1)
            latest_day = max(timestamps).date()
        else:
            range_days = 30
            latest_day = date.today()

    st.caption(f"Leaderboard window: {range_label}")

    if not login_summary and not conversation_summary:
        st.warning("No login or conversation activity found in this period.")
        return

    weeks = max(range_days / 7, 1)

    mau = len(login_summary)
    dau = daily_logins.get(latest_day, 0)
    avg_daily_conversations = (
        sum(daily_conversations.values()) / len(daily_conversations)
        if daily_conversations
        else 0.0
    )
    avg_daily_projects = (
        sum(daily_projects.values()) / len(daily_projects)
        if daily_projects
        else 0.0
    )

    kpi_cols = st.columns(4)
    with kpi_cols[0]:
        st.metric("MAU", mau)
    with kpi_cols[1]:
        st.metric("DAU", dau)
    with kpi_cols[2]:
        st.metric("Avg Daily Conversations", f"{avg_daily_conversations:.1f}")
    with kpi_cols[3]:
        st.metric("Avg Daily Projects", f"{avg_daily_projects:.1f}")

    stats_key = f"dashboard_llm_{_dashboard_cache_key(dashboard_range)}"
    if stats_key not in st.session_state:
        from src.usage_tracker.llm_insights import DashboardStats, generate_dashboard_overview

        top_users_for_llm = []
        for user_id, data in sorted(
            login_summary.items(), key=lambda item: item[1]["count"], reverse=True
        )[:5]:
            info = user_lookup.get(user_id)
            if info and _is_ignored_email(info.email):
                continue
            label = info.display_name if info else user_id
            top_users_for_llm.append((label, data.get("count", 0)))

        top_project_entries = sorted(
            project_activity.values(),
            key=lambda entry: (entry.get("conversations", 0), entry.get("chat_sessions", 0)),
            reverse=True,
        )[:5]
        top_projects_for_llm = [
            (
                entry.get("project_name"),
                entry.get("conversations", 0),
                entry.get("chat_sessions", 0),
            )
            for entry in top_project_entries
        ]

        stats_payload = DashboardStats(
            range_label=range_label,
            mau=mau,
            dau=dau,
            avg_daily_conversations=avg_daily_conversations,
            avg_daily_projects=avg_daily_projects,
            top_users=top_users_for_llm,
            top_projects=top_projects_for_llm,
            ignored_accounts=sorted(IGNORED_LLM_EMAILS),
        )
        st.session_state[stats_key] = generate_dashboard_overview(stats_payload)

    st.markdown(st.session_state[stats_key])

    render_dashboard_insight_pipelines(
        client=client,
        login_summary=login_summary,
        project_activity=project_activity,
        login_daily_by_user=login_daily_by_user,
        user_lookup=user_lookup,
        selected_range=selected_range,
        range_days=range_days,
    )

    power_rows = []
    for user_id, data in login_summary.items():
        info = user_lookup.get(user_id)
        email = info.email if info else ""
        domain = "—"
        if email and "@" in email:
            domain = email.split("@")[-1].lower()
        conv_stats = conversation_summary.get(user_id, {})
        power_rows.append(
            {
                "user_id": user_id,
                "name": info.display_name if info else f"User {user_id}",
                "email": email,
                "domain": domain,
                "logins": data.get("count", 0),
                "avg_week": data.get("count", 0) / weeks,
                "last_login": data.get("last"),
                "conversations": conv_stats.get("count", 0),
            }
        )

    power_rows.sort(key=lambda row: (row["avg_week"], row["logins"]), reverse=True)

    st.subheader("Top Power Users")
    show_more = st.checkbox("Show 40 users", value=False, key="show_top40_power")
    display_count = 40 if show_more else 20
    displayed_power = power_rows[:display_count]

    power_selection: List[str] = []
    if displayed_power:
        power_table = pd.DataFrame(
            [
                {
                    "Name": row["name"],
                    "Email": row["email"] or "—",
                    "Logins": row["logins"],
                    "Avg / Week": round(row["avg_week"], 1),
                    "Conversations": row["conversations"],
                    "Last Login": _format_ts(row["last_login"]),
                    "Analyze?": False,
                }
                for row in displayed_power
            ]
        )
        st.caption("Tick rows to analyze directly from this table")
        edited_power = st.data_editor(
            power_table,
            hide_index=True,
            key="power_table_editor",
            column_config={
                "Analyze?": st.column_config.CheckboxColumn(
                    "Analyze?", help="Select users to drill into"
                )
            },
        )
        if "Analyze?" in edited_power:
            power_selection = [
                displayed_power[idx]["user_id"]
                for idx, checked in enumerate(edited_power["Analyze?"])
                if checked and displayed_power[idx]["user_id"]
            ]
    else:
        st.info("No login activity to rank power users.")

    st.divider()

    # Top orgs (dedupe by domain)
    st.subheader("Top Orgs by Activity (deduped by email domain)")
    org_rows = []
    seen_domains = set()
    combined_sorted = sorted(
        power_rows,
        key=lambda row: (row["logins"] + row["conversations"]),
        reverse=True,
    )
    for row in combined_sorted:
        domain = row["domain"] or "—"
        if domain in seen_domains:
            continue
        seen_domains.add(domain)
        org_rows.append(
            {
                "Domain": domain,
                "Representative": row["name"],
                "Logins": row["logins"],
                "Conversations": row["conversations"],
            }
        )
        if len(org_rows) >= 10:
            break

    if org_rows:
        org_df = pd.DataFrame(org_rows)
        st.dataframe(org_df, use_container_width=True, hide_index=True)
    else:
        st.info("No organization-level activity detected.")

    st.divider()

    # Top projects table
    st.subheader("Top Projects (Conversations & Chats)")
    project_rows = sorted(
        project_activity.values(),
        key=lambda entry: (entry.get("conversations", 0), entry.get("chat_sessions", 0)),
        reverse=True,
    )[:10]

    if project_rows:
        project_table = pd.DataFrame(
            [
                {
                    "Project": entry.get("project_name"),
                    "Owner": user_lookup.get(entry.get("owner_id")).display_name
                    if user_lookup.get(entry.get("owner_id"))
                    else entry.get("owner_id")
                    or "—",
                    "Conversations": entry.get("conversations", 0),
                    "Chats": entry.get("chat_sessions", 0),
                    "Last Conversation": _format_ts(entry.get("last_conversation")),
                    "Last Chat": _format_ts(entry.get("last_chat")),
                }
                for entry in project_rows
            ]
        )
        st.data_editor(
            project_table,
            hide_index=True,
            use_container_width=True,
            disabled=True,
            column_config={
                "Project": st.column_config.Column(width="large"),
                "Owner": st.column_config.Column(width="medium"),
            },
            key="top_projects_editor",
        )
    else:
        st.info("No project-level activity detected.")

    st.divider()

    # Top conversation users (may include users without recent logins)
    st.subheader("Top Conversation Drivers")
    conv_rows = []
    for user_id, stats in conversation_summary.items():
        info = user_lookup.get(user_id)
        conv_rows.append(
            {
                "user_id": user_id,
                "name": info.display_name if info else f"User {user_id}",
                "email": info.email if info else "—",
                "conversations": stats.get("count", 0),
                "last_conversation": _format_ts(stats.get("last")),
                "logins": login_summary.get(user_id, {}).get("count", 0),
            }
        )

    conv_rows.sort(key=lambda row: row["conversations"], reverse=True)
    top_conv = conv_rows[:10]
    conv_selection: List[str] = []
    if top_conv:
        conv_table = pd.DataFrame(
            [
                {
                    "Name": row["name"],
                    "Email": row["email"],
                    "Conversations": row["conversations"],
                    "Recent Conversation": row["last_conversation"],
                    "Logins": row["logins"],
                    "Analyze?": False,
                }
                for row in top_conv
            ]
        )
        edited_conv = st.data_editor(
            conv_table,
            hide_index=True,
            key="conversation_table_editor",
            column_config={
                "Analyze?": st.column_config.CheckboxColumn("Analyze?"),
            },
        )
        if "Analyze?" in edited_conv:
            conv_selection = [
                top_conv[idx]["user_id"]
                for idx, checked in enumerate(edited_conv["Analyze?"])
                if checked and top_conv[idx]["user_id"]
            ]
    else:
        st.info("No conversations recorded during this period.")
    # Selection helper
    selected_candidates = sorted(set(power_selection + conv_selection))
    if selected_candidates:
        st.success(f"Selected {len(selected_candidates)} user(s) from tables.")
    if st.button("Analyze selected users", type="primary", disabled=not selected_candidates):
        st.session_state.selected_user_ids = selected_candidates
        st.experimental_rerun()

def render_monthly_summary(
    metrics: UsageMetrics,
    usage_data: List[UserUsageData],
    selected_range: Optional[DateRange],
    monthly_stats_override: Optional[List[MonthlyStats]] = None,
    note: Optional[str] = None,
):
    """Render monthly summary chart with trends, distributions, and ratios."""
    monthly_stats = monthly_stats_override or metrics.timeline.monthly_stats
    if not monthly_stats or len(monthly_stats) < 2:
        st.info("Not enough monthly data available (need at least 2 months)")
        return

    chart_data = [
        {
            "month": month.month_label,
            "month_key": month.month_key,
            "conversations_valid": month.conversations_valid,
            "conversations_empty": month.conversations_empty,
            "duration_hours": month.duration_seconds / 3600,
            "chats": month.chats,
        }
        for month in monthly_stats
    ]

    chart_df = pd.DataFrame(chart_data)
    conversation_counts = [m.conversations for m in monthly_stats]
    chat_counts = [m.chats for m in monthly_stats]
    valid_counts = [m.conversations_valid for m in monthly_stats]

    monthly_login_counts: Dict[str, int] = defaultdict(int)
    for day, count in metrics.logins.daily_logins.items():
        key = f"{day.year}-{day.month:02d}"
        monthly_login_counts[key] += count
    login_counts_ordered = [monthly_login_counts.get(m.month_key, 0) for m in monthly_stats]

    def _safe_mean(values: List[int]) -> float:
        return sum(values) / len(values) if values else 0.0

    summary_metrics = {
        "avg_conversations": _safe_mean(conversation_counts),
        "median_conversations": statistics.median(conversation_counts) if conversation_counts else 0.0,
        "p90_conversations": _percentile(sorted(conversation_counts), 0.9) if conversation_counts else 0.0,
        "avg_chats": _safe_mean(chat_counts),
        "median_chats": statistics.median(chat_counts) if chat_counts else 0.0,
        "p90_chats": _percentile(sorted(chat_counts), 0.9) if chat_counts else 0.0,
        "avg_logins": _safe_mean(login_counts_ordered),
        "median_logins": statistics.median(login_counts_ordered) if login_counts_ordered else 0.0,
        "p90_logins": _percentile(sorted(login_counts_ordered), 0.9) if login_counts_ordered else 0.0,
    }

    ratio_valid = (
        sum(valid_counts) / sum(conversation_counts) if conversation_counts and sum(conversation_counts) else 0.0
    )
    avg_duration_per_conversation = (
        sum(m.duration_seconds for m in monthly_stats) / sum(conversation_counts)
        if conversation_counts and sum(conversation_counts)
        else 0.0
    )

    st.subheader("Monthly Overview")
    metric_cols = st.columns(3)
    with metric_cols[0]:
        st.metric(
            "Avg Conversations / Mo",
            f"{summary_metrics['avg_conversations']:.1f}",
            help="Mean monthly conversation count",
        )
        st.caption(
            f"Median {summary_metrics['median_conversations']:.1f} · P90 {summary_metrics['p90_conversations']:.1f}"
        )
    with metric_cols[1]:
        st.metric(
            "Avg Chat Sessions / Mo",
            f"{summary_metrics['avg_chats']:.1f}",
            help="Mean monthly chat sessions",
        )
        st.caption(f"Median {summary_metrics['median_chats']:.1f} · P90 {summary_metrics['p90_chats']:.1f}")
    with metric_cols[2]:
        st.metric(
            "Avg Logins / Mo",
            f"{summary_metrics['avg_logins']:.1f}",
            help="Mean monthly Directus logins",
        )
        st.caption(f"Median {summary_metrics['median_logins']:.1f} · P90 {summary_metrics['p90_logins']:.1f}")

    months_label = f"{monthly_stats[0].month_label} – {monthly_stats[-1].month_label}"
    range_start_key = selected_range.start.isoformat() if selected_range else "all"
    range_end_key = selected_range.end.isoformat() if selected_range else "all"
    llm_cache_key = f"monthly_overview_{months_label}_{range_start_key}_{range_end_key}"
    if llm_cache_key not in st.session_state:
        payload = MonthlyOverviewPayload(
            range_label=months_label,
            avg_conversations=summary_metrics["avg_conversations"],
            median_conversations=summary_metrics["median_conversations"],
            p90_conversations=summary_metrics["p90_conversations"],
            avg_chats=summary_metrics["avg_chats"],
            avg_logins=summary_metrics["avg_logins"],
            content_ratio=ratio_valid,
            duration_per_conversation=avg_duration_per_conversation,
            conversations_per_project=(
                summary_metrics["avg_conversations"] / metrics.projects.total_projects
                if metrics.projects.total_projects
                else 0.0
            ),
        )
        st.session_state[llm_cache_key] = generate_monthly_overview(payload)
    st.info(st.session_state[llm_cache_key])

    # Create dual-axis chart
    fig = make_subplots(specs=[[{"secondary_y": True}]])

    # Stacked bar: valid conversations (blue) at bottom
    fig.add_trace(
        go.Bar(
            x=chart_df["month"],
            y=chart_df["conversations_valid"],
            name="Conversations (with content)",
            marker_color="#667eea",
            opacity=0.9,
            hovertemplate="<b>%{x}</b><br>Valid: %{y}<extra></extra>",
        ),
        secondary_y=False,
    )

    # Stacked bar: empty conversations (red) on top
    fig.add_trace(
        go.Bar(
            x=chart_df["month"],
            y=chart_df["conversations_empty"],
            name="Conversations (empty/no transcript)",
            marker_color="#ef4444",
            opacity=0.9,
            hovertemplate="<b>%{x}</b><br>Empty: %{y}<extra></extra>",
        ),
        secondary_y=False,
    )

    fig.add_trace(
        go.Scatter(
            x=chart_df["month"],
            y=chart_df["duration_hours"],
            name="Duration (hours)",
            line=dict(color="#f5576c", width=3),
            mode="lines+markers",
            marker=dict(size=8),
        ),
        secondary_y=True,
    )

    fig.add_trace(
        go.Scatter(
            x=chart_df["month"],
            y=chart_df["chats"],
            name="Chats",
            line=dict(color="#4ecdc4", width=2, dash="dash"),
            mode="lines+markers",
            marker=dict(size=6, symbol="square"),
        ),
        secondary_y=False,
    )

    fig.update_layout(
        barmode="stack",
        hovermode="x unified",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        height=400,
        margin=dict(t=30, b=10),
    )

    fig.update_yaxes(title="Conversations / Chats", secondary_y=False)
    fig.update_yaxes(title="Duration (hours)", secondary_y=True)

    st.plotly_chart(fig, use_container_width=True)

    if note:
        st.caption(note)

    # Add legend explanation
    st.caption(
        "**Blue bars** = conversations with audio content · "
        "**Red bars** = empty conversations (no chunks/transcript) · "
        "**Red line** = duration in hours · "
        "**Teal dashed** = chat sessions"
    )

    st.subheader("Distribution Metrics")
    conversation_durations: List[int] = []
    conversation_lengths: List[int] = []
    for ud in usage_data:
        for conv in ud.conversations:
            if not conv.created_at:
                continue
            conv_day = conv.created_at.date()
            if selected_range and (conv_day < selected_range.start or conv_day > selected_range.end):
                continue
            conversation_durations.append(estimate_conversation_duration(conv))
            conversation_lengths.append(conv.chunk_count or 0)

    def describe_distribution(values: List[int]) -> Dict[str, float]:
        if not values:
            return {"p25": 0.0, "median": 0.0, "p75": 0.0}
        sorted_vals = sorted(values)
        return {
            "p25": _percentile(sorted_vals, 0.25),
            "median": _percentile(sorted_vals, 0.5),
            "p75": _percentile(sorted_vals, 0.75),
        }

    duration_stats = describe_distribution(conversation_durations)
    length_stats = describe_distribution(conversation_lengths)
    daily_conv_values = list(metrics.timeline.daily_conversations.values())
    mode_daily = max(set(daily_conv_values), key=daily_conv_values.count) if daily_conv_values else 0

    weekly_totals: List[int] = []
    if metrics.timeline.daily_conversations:
        sorted_days = sorted(metrics.timeline.daily_conversations.keys())
        buffer = []
        for day in sorted_days:
            buffer.append(metrics.timeline.daily_conversations[day])
            if len(buffer) == 7:
                weekly_totals.append(sum(buffer))
                buffer = []
        if buffer:
            weekly_totals.append(sum(buffer))
    mode_weekly = max(set(weekly_totals), key=weekly_totals.count) if weekly_totals else 0

    dist_cols = st.columns(3)
    dist_cols[0].metric(
        "Duration P25 / P50 / P75",
        f"{duration_stats['p25'] / 60:.1f}m / {duration_stats['median'] / 60:.1f}m / {duration_stats['p75'] / 60:.1f}m",
    )
    dist_cols[1].metric(
        "Chunks P25 / P50 / P75",
        f"{length_stats['p25']:.0f} / {length_stats['median']:.0f} / {length_stats['p75']:.0f}",
    )
    dist_cols[2].metric("Mode conversations (day/week)", f"{mode_daily} per day · {mode_weekly} per week")

    st.subheader("Trend Indicators")
    month_over_month = 0.0
    if len(conversation_counts) >= 2 and conversation_counts[-2]:
        month_over_month = ((conversation_counts[-1] - conversation_counts[-2]) / conversation_counts[-2]) * 100
    daily_counts_list = [
        metrics.timeline.daily_conversations[d]
        for d in sorted(metrics.timeline.daily_conversations.keys())
    ]
    if daily_counts_list:
        daily_counts_series = pd.Series(daily_counts_list)
        ma_7 = (
            daily_counts_series.rolling(window=7).mean().iloc[-1]
            if len(daily_counts_series) >= 7
            else daily_counts_series.mean()
        )
        ma_30 = (
            daily_counts_series.rolling(window=30).mean().iloc[-1]
            if len(daily_counts_series) >= 30
            else daily_counts_series.mean()
        )
        variance = statistics.pvariance(daily_counts_list) if len(daily_counts_list) > 1 else 0.0
    else:
        ma_7 = ma_30 = variance = 0.0

    trend_cols = st.columns(3)
    trend_cols[0].metric("MoM conversation growth", f"{month_over_month:.1f}%")
    trend_cols[1].metric("7-day / 30-day MA", f"{ma_7:.1f} / {ma_30:.1f} convs")
    trend_cols[2].metric("Daily variance", f"{variance:.1f}")

    st.subheader("Segmentation")
    new_users = returning_users = heavy_users = light_users = 0
    range_start = selected_range.start if selected_range else None
    for ud in usage_data:
        conv_count = len(ud.conversations)
        if conv_count >= 10:
            heavy_users += 1
        elif conv_count > 0:
            light_users += 1
        if range_start and ud.first_activity and ud.first_activity.date() >= range_start:
            new_users += 1
        elif conv_count > 0:
            returning_users += 1

    seg_cols = st.columns(4)
    seg_cols[0].metric("New users", new_users)
    seg_cols[1].metric("Returning users", returning_users)
    seg_cols[2].metric("Heavy users (≥10 convs)", heavy_users)
    seg_cols[3].metric("Light users", light_users)

    weekday_counter = Counter()
    hour_counter = Counter()
    for ud in usage_data:
        for conv in ud.conversations:
            if not conv.created_at:
                continue
            weekday_counter[conv.created_at.strftime("%A")] += 1
            hour_counter[conv.created_at.hour] += 1
    peak_day = max(weekday_counter, key=weekday_counter.get) if weekday_counter else None
    peak_hour = max(hour_counter, key=hour_counter.get) if hour_counter else None
    if peak_day or peak_hour is not None:
        hour_text = f"{peak_hour}:00" if peak_hour is not None else "n/a"
        st.caption(f"Peak day: **{peak_day or 'n/a'}** · Peak hour: **{hour_text}**")
    else:
        st.caption("Peak usage data unavailable")

    st.subheader("Quality & Efficiency Ratios")
    total_conversations = sum(conversation_counts)
    conversations_per_project = (
        total_conversations / metrics.projects.total_projects if metrics.projects.total_projects else 0.0
    )
    ratio_cols = st.columns(3)
    ratio_cols[0].metric("Content-to-empty ratio", f"{ratio_valid:.0%}")
    ratio_cols[1].metric("Avg duration per conversation", format_duration(int(avg_duration_per_conversation)))
    ratio_cols[2].metric("Conversations per project", f"{conversations_per_project:.1f}")


def render_word_cloud(metrics: UsageMetrics):
    """Render word cloud from chat queries (compact)."""
    if not metrics.chat.top_query_words:
        st.caption("Not enough data for word cloud")
        return

    try:
        from wordcloud import WordCloud
        import matplotlib.pyplot as plt

        word_freq = dict(metrics.chat.top_query_words)

        wc = WordCloud(
            width=400,
            height=200,
            background_color="white",
            colormap="viridis",
            max_words=30,
            prefer_horizontal=0.8,
        ).generate_from_frequencies(word_freq)

        fig, ax = plt.subplots(figsize=(5, 2.5))
        ax.imshow(wc, interpolation="bilinear")
        ax.axis("off")
        plt.tight_layout(pad=0)

        st.pyplot(fig)

    except ImportError:
        top_10 = metrics.chat.top_query_words[:10]
        df = pd.DataFrame(top_10, columns=["word", "count"])

        fig = px.bar(
            df,
            x="count",
            y="word",
            orientation="h",
            title="Top Query Terms",
            color="count",
            color_continuous_scale="viridis",
        )
        fig.update_layout(height=500, showlegend=False)
        st.plotly_chart(fig, use_container_width=True)


def render_feature_adoption(metrics: UsageMetrics):
    """Render feature adoption chart."""
    features = [
        ("Conversations", metrics.adoption.uses_conversations, metrics.audio.total_conversations),
        ("Chat", metrics.adoption.uses_chat, metrics.chat.total_chats),
        ("Reports", metrics.adoption.uses_reports, metrics.reports.total_reports),
    ]

    df = pd.DataFrame(features, columns=["Feature", "Active", "Count"])
    df["Status"] = df["Active"].map({True: "Active", False: "Not Used"})

    fig = px.bar(
        df,
        x="Feature",
        y="Count",
        color="Status",
        title="Feature Usage",
        color_discrete_map={"Active": "#667eea", "Not Used": "#e0e0e0"},
    )
    fig.update_layout(height=350)

    st.plotly_chart(fig, use_container_width=True)


def render_projects_table(usage_data: List[UserUsageData]):
    """Render projects summary table with per-project metrics."""
    # Build lookup maps for conversations, chats, messages by project
    conversations_by_project: dict = {}
    chats_by_project: dict = {}
    messages_by_chat: dict = {}

    for ud in usage_data:
        for conv in ud.conversations:
            if conv.project_id not in conversations_by_project:
                conversations_by_project[conv.project_id] = []
            conversations_by_project[conv.project_id].append(conv)

        for chat in ud.chats:
            if chat.project_id not in chats_by_project:
                chats_by_project[chat.project_id] = []
            chats_by_project[chat.project_id].append(chat)

        for msg in ud.chat_messages:
            if msg.chat_id not in messages_by_chat:
                messages_by_chat[msg.chat_id] = []
            messages_by_chat[msg.chat_id].append(msg)

    projects = []
    for ud in usage_data:
        for p in ud.projects:
            # Calculate duration for this project
            project_convs = conversations_by_project.get(p.id, [])
            total_duration = sum(estimate_conversation_duration(c) for c in project_convs)

            # Calculate chat metrics for this project
            project_chats = chats_by_project.get(p.id, [])
            chat_count = len(project_chats)

            # Count messages across all chats in this project
            message_count = 0
            user_message_count = 0
            for chat in project_chats:
                chat_msgs = messages_by_chat.get(chat.id, [])
                message_count += len(chat_msgs)
                user_message_count += sum(
                    1 for m in chat_msgs if m.message_from and m.message_from.lower() == "user"
                )

            projects.append(
                {
                    "Project Name": p.name,
                    "Owner": ud.user.display_name,
                    "Conversations": len(project_convs),
                    "_duration_secs": total_duration,  # Hidden column for sorting
                    "⏱ Duration": format_duration(total_duration) if total_duration > 0 else "-",
                    "Chats": chat_count,
                    "Messages": message_count,
                    "User Msgs": user_message_count,
                    "Created": p.created_at.strftime("%Y-%m-%d") if p.created_at else "N/A",
                    "Status": "Active" if p.is_conversation_allowed else "Paused",
                }
            )

    if not projects:
        st.info("No projects found")
        return

    df = pd.DataFrame(projects)
    # Sort by duration (numeric), then drop the hidden sort column
    df = df.sort_values("_duration_secs", ascending=False)
    df = df.drop(columns=["_duration_secs"])

    st.dataframe(
        df,
        use_container_width=True,
        hide_index=True,
        column_config={
            "Project Name": st.column_config.TextColumn("Project Name", width="large"),
            "Conversations": st.column_config.NumberColumn("Conversations", format="%d"),
            "⏱ Duration": st.column_config.TextColumn("Duration"),
            "Chats": st.column_config.NumberColumn("Chats", format="%d"),
            "Messages": st.column_config.NumberColumn("Messages", format="%d"),
            "User Msgs": st.column_config.NumberColumn("User Msgs", format="%d"),
        },
    )


def main():
    """Main app entry point."""
    # Header
    st.markdown('<p class="main-header">📊 ECHO Usage Tracker</p>', unsafe_allow_html=True)
    st.markdown(
        '<p class="sub-header">Customer usage analytics for sales teams</p>',
        unsafe_allow_html=True,
    )

    # Initialize client
    client = get_directus_client()
    if client is None:
        st.error("⚠️ Could not connect to Directus. Check your configuration.")
        st.code("""
# Required environment variables:
DIRECTUS_BASE_URL=https://your-directus-instance.com
DIRECTUS_TOKEN=your-admin-token
        """)
        st.stop()

    # Sidebar - Date Range first
    st.sidebar.header("📅 Date Range")

    date_ranges = get_date_ranges()
    date_range_options = list(date_ranges.keys())
    default_range_label = "Last 30 Days"
    default_index = (
        date_range_options.index(default_range_label)
        if default_range_label in date_range_options
        else 0
    )
    selected_range_name = st.sidebar.selectbox(
        "Time period",
        options=date_range_options,
        index=default_index,
    )

    if selected_range_name == "All Time":
        date_range = None  # No date filtering
    elif selected_range_name == "Custom Range":
        col1, col2 = st.sidebar.columns(2)
        with col1:
            custom_start = st.date_input("Start", value=date.today() - timedelta(days=30))
        with col2:
            custom_end = st.date_input("End", value=date.today())
        date_range = DateRange(custom_start, custom_end)
    else:
        date_range = date_ranges[selected_range_name]

    # Sidebar - User Selection
    st.sidebar.divider()
    st.sidebar.header("🔍 User Selection")

    # Initialize session state for persisting selections
    if "selected_user_ids" not in st.session_state:
        st.session_state.selected_user_ids = []
    if "last_search_query" not in st.session_state:
        st.session_state.last_search_query = ""

    # Load users
    with st.spinner("Loading users..."):
        all_users = fetch_all_users(client)

    if not all_users:
        st.warning("No users found in Directus")
        st.stop()

    # Create a lookup for all users by ID
    all_users_by_id = {u.id: u for u in all_users}

    # Search box
    search_query = st.sidebar.text_input(
        "Search users",
        value=st.session_state.last_search_query,
        placeholder="Search by email or name...",
        key="user_search",
    )
    st.session_state.last_search_query = search_query

    # Filter users based on search
    if search_query:
        search_lower = search_query.lower()
        filtered_users = [
            u
            for u in all_users
            if (u.email and search_lower in u.email.lower())
            or (u.first_name and search_lower in u.first_name.lower())
            or (u.last_name and search_lower in u.last_name.lower())
        ]
    else:
        filtered_users = all_users

    # Build options - always include previously selected users even if not in current filter
    # This prevents losing selections when searching
    filtered_ids = {u.id for u in filtered_users}
    previously_selected = [
        all_users_by_id[uid]
        for uid in st.session_state.selected_user_ids
        if uid in all_users_by_id and uid not in filtered_ids
    ]
    display_users = filtered_users + previously_selected
    
    user_options = {u.id: f"{u.display_name} ({u.email})" for u in display_users}

    # Restore previously selected users that still exist
    default_selection = [
        uid for uid in st.session_state.selected_user_ids
        if uid in all_users_by_id
    ]

    selected_user_ids = st.sidebar.multiselect(
        "Select users",
        options=list(user_options.keys()),
        default=default_selection,
        format_func=lambda x: user_options.get(x, x),
        help="Select one or more users to analyze",
    )
    
    # Save selection to session state
    st.session_state.selected_user_ids = selected_user_ids

    # Refresh button
    st.sidebar.divider()
    if st.sidebar.button("🔄 Refresh Data", help="Clear cache and reload data"):
        # Clear all usage_data cache keys from session state
        keys_to_clear = [k for k in st.session_state.keys() if k.startswith("usage_data_")]
        for key in keys_to_clear:
            del st.session_state[key]
        # Also clear the Streamlit cache
        st.cache_data.clear()
        st.rerun()

    # Main content
    if not selected_user_ids:
        render_power_user_dashboard(client, all_users, date_range)
        return

    # Fetch data
    selected_users = [u for u in all_users if u.id in selected_user_ids]

    # Use a cache key to avoid refetching on every rerun
    cache_key = f"usage_data_{tuple(sorted(selected_user_ids))}_{date_range}"
    if cache_key not in st.session_state:
        # Fetch with progress bar
        usage_data = fetch_user_data_with_progress(
            client,
            selected_user_ids,
            date_range,
        )
        st.session_state[cache_key] = usage_data
    else:
        usage_data = st.session_state[cache_key]

    if not usage_data:
        st.warning("No data found for selected users in the specified date range")
        return

    # Calculate metrics
    metrics = calculate_metrics(usage_data)

    monthly_stats_override = None
    monthly_note = None
    if date_range:
        monthly_note = "Monthly summary shows full history (ignores selected date range)."
        cache_suffix = "_".join(sorted(selected_user_ids)) or "none"
        monthly_cache_key = f"monthly_stats_all_time_{cache_suffix}"
        if monthly_cache_key in st.session_state:
            monthly_stats_override = st.session_state[monthly_cache_key]
        else:
            with st.spinner("Loading all-time history for monthly summary..."):
                all_time_usage = fetch_user_data_cached(
                    client,
                    tuple(sorted(selected_user_ids)),
                    None,
                    None,
                )
            if all_time_usage:
                monthly_stats_override = calculate_metrics(all_time_usage).timeline.monthly_stats
                st.session_state[monthly_cache_key] = monthly_stats_override
            else:
                monthly_note = "Monthly summary limited to selected range (unable to load all-time data)."

    # Calculate trends (compare to previous period) - use cached version (no progress)
    trends = {}
    if date_range:
        prev_range = get_period_comparison(date_range)
        with st.spinner("Calculating trends..."):
            prev_data = fetch_user_data_cached(
                client,
                tuple(selected_user_ids),
                prev_range.start,
                prev_range.end,
            )
        if prev_data:
            prev_metrics = calculate_metrics(prev_data)
            trends = calculate_trends(metrics, prev_metrics)

    # Display selected users
    st.markdown(f"**Showing data for:** {', '.join(u.display_name for u in selected_users)}")
    if date_range:
        st.markdown(
            f"**Period:** {date_range.start.strftime('%B %d, %Y')} - {date_range.end.strftime('%B %d, %Y')}"
        )
    else:
        st.markdown("**Period:** All Time")

    st.divider()

    # Metric cards
    render_metric_cards(metrics, trends)
    render_login_tier_banner(metrics)

    st.divider()

    # Tabs for different views
    (
        tab_monthly,
        tab_logins,
        tab_chat,
        tab_projects,
        tab_export,
    ) = st.tabs(
        [
            "📅 Monthly",
            "🔐 Login Activity",
            "💬 Chat Analysis",
            "📁 Projects",
            "📄 Export",
        ]
    )

    with tab_monthly:
        render_monthly_summary(
            metrics,
            usage_data=usage_data,
            selected_range=date_range,
            monthly_stats_override=monthly_stats_override,
            note=monthly_note,
        )

    with tab_logins:
        render_login_activity(metrics, selected_users)

    with tab_chat:
        if metrics.chat.total_chats == 0:
            st.info("No chat data available for analysis")
        else:
            # Compact metrics bar
            queries_per_session = metrics.chat.user_messages / metrics.chat.total_chats if metrics.chat.total_chats > 0 else 0
            st.caption(
                f"**{metrics.chat.total_chats}** sessions · "
                f"**{metrics.chat.total_messages}** msgs · "
                f"**{metrics.chat.user_messages}** queries · "
                f"**{queries_per_session:.1f}** q/session · "
                f"P50: **{metrics.chat.p50_messages_per_chat:.0f}** · "
                f"P90: **{metrics.chat.p90_messages_per_chat:.0f}** msg/session"
            )

            col1, col2 = st.columns([1, 1])

            with col1:
                render_word_cloud(metrics)

            with col2:
                # LLM Analysis
                if metrics.chat.user_messages > 0:
                    sample_note = f" ({metrics.chat.user_messages})" if metrics.chat.user_messages > 500 else ""
                    
                    if st.button(f"🤖 Analyze{sample_note}", key="chat_analysis_btn"):
                        user_texts = [
                            m.text for ud in usage_data for m in ud.chat_messages
                            if m.message_from and m.message_from.lower() == "user" and m.text
                        ]
                        with st.spinner("Analyzing..."):
                            analysis = analyze_chat_messages(user_texts)
                            st.session_state["chat_analysis"] = analysis

                    if "chat_analysis" in st.session_state:
                        st.markdown(st.session_state["chat_analysis"])

    with tab_projects:
        col1, col2, col3 = st.columns(3)
        with col1:
            st.metric("Total Projects", metrics.projects.total_projects)
        with col2:
            st.metric("Active Projects", metrics.projects.active_projects)
        with col3:
            st.metric("Avg Convos/Project", f"{metrics.projects.avg_conversations_per_project:.1f}")

        render_projects_table(usage_data)

    with tab_export:
        include_insights = st.checkbox("Include AI insights", value=True)

        if st.button("Generate PDF Report", type="primary"):
            with st.spinner("Generating PDF..."):
                try:
                    # Generate executive summary
                    exec_summary = generate_executive_summary(selected_users, metrics)

                    # Get insights if requested and available
                    insights = None
                    if include_insights:
                        insights = st.session_state.get("insights")
                        if not insights:
                            try:
                                insights = generate_insights(selected_users, metrics, trends)
                            except Exception:
                                pass

                    # Generate PDF
                    pdf_bytes = generate_pdf_report(
                        users=selected_users,
                        metrics=metrics,
                        date_range=date_range,
                        executive_summary=exec_summary,
                        insights=insights,
                        usage_data=usage_data,
                    )

                    # Download button
                    filename = f"usage_report_{date.today().strftime('%Y%m%d')}.pdf"

                    st.download_button(
                        label="⬇️ Download PDF",
                        data=pdf_bytes,
                        file_name=filename,
                        mime="application/pdf",
                    )

                    st.success("Report generated successfully!")

                except Exception as e:
                    st.error(f"Failed to generate PDF: {e}")
                    logger.exception("PDF generation failed")


if __name__ == "__main__":
    main()
