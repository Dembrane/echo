"""
Dembrane ECHO Usage Tracker

A customer usage reporting tool for sales teams.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import List, Optional, Tuple

import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
        format_duration,
    )
    from src.usage_tracker.llm_insights import (
        generate_insights,
        generate_executive_summary,
        generate_timeline_insights,
        analyze_chat_messages,
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
    cols = st.columns(4)

    with cols[0]:
        st.metric(
            "Conversations",
            metrics.audio.total_conversations,
            delta=_format_delta(trends.get("conversations", (0, "flat"))),
        )
        st.caption(f"⏱ Avg {metrics.audio.avg_duration_formatted} each")

    with cols[1]:
        st.metric(
            "Total Duration",
            metrics.audio.total_duration_formatted,
            delta=_format_delta(trends.get("duration", (0, "flat"))),
        )
        st.caption(f"P50 {metrics.audio.p50_duration_formatted} · P90 {metrics.audio.p90_duration_formatted}")

    with cols[2]:
        st.metric(
            "Chat Sessions",
            metrics.chat.total_chats,
            delta=_format_delta(trends.get("chats", (0, "flat"))),
        )
        if metrics.chat.total_chats > 0:
            avg_msgs = metrics.chat.total_messages / metrics.chat.total_chats
            st.caption(f"💬 {metrics.chat.user_messages} queries · {avg_msgs:.0f} msg/session")

    with cols[3]:
        st.metric(
            "Reports",
            metrics.reports.total_reports,
            delta=_format_delta(trends.get("reports", (0, "flat"))),
        )
        if metrics.reports.total_reports > 0:
            st.caption(f"✓ {metrics.reports.published_reports} published")


def render_timeline_chart(metrics: UsageMetrics):
    """Render the activity timeline chart with conversations and duration."""
    from src.usage_tracker.metrics import format_duration

    if not metrics.timeline.daily_conversations:
        st.info("No activity data available for timeline")
        return

    # Convert to dataframe
    dates = sorted(metrics.timeline.daily_conversations.keys())
    if not dates:
        return

    # Fill in missing dates
    all_dates = pd.date_range(start=min(dates), end=max(dates), freq="D")

    data = []
    for d in all_dates:
        day = d.date()
        duration_secs = metrics.timeline.daily_duration.get(day, 0)
        data.append(
            {
                "date": day,
                "conversations": metrics.timeline.daily_conversations.get(day, 0),
                "duration_mins": duration_secs / 60,  # Convert to minutes for chart
                "duration_formatted": format_duration(duration_secs),
                "chats": metrics.timeline.daily_chats.get(day, 0),
                "messages": metrics.timeline.daily_messages.get(day, 0),
            }
        )

    df = pd.DataFrame(data)

    # Create figure with secondary y-axis
    fig = make_subplots(specs=[[{"secondary_y": True}]])

    # Conversations bar
    fig.add_trace(
        go.Bar(
            x=df["date"],
            y=df["conversations"],
            name="Conversations",
            marker_color="#667eea",
            opacity=0.8,
            hovertemplate="<b>%{x}</b><br>Conversations: %{y}<extra></extra>",
        ),
        secondary_y=False,
    )

    # Duration line
    fig.add_trace(
        go.Scatter(
            x=df["date"],
            y=df["duration_mins"],
            name="Duration (mins)",
            line=dict(color="#f5576c", width=3),
            mode="lines+markers",
            marker=dict(size=6),
            customdata=df["duration_formatted"],
            hovertemplate="<b>%{x}</b><br>Duration: %{customdata}<extra></extra>",
        ),
        secondary_y=True,
    )

    # Chat messages line
    fig.add_trace(
        go.Scatter(
            x=df["date"],
            y=df["messages"],
            name="Chat Messages",
            line=dict(color="#4ecdc4", width=2, dash="dot"),
            mode="lines+markers",
            marker=dict(size=4, symbol="diamond"),
            hovertemplate="<b>%{x}</b><br>Chat Messages: %{y}<extra></extra>",
        ),
        secondary_y=True,
    )

    fig.update_layout(
        hovermode="x unified",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        height=400,
        margin=dict(t=30, b=10),
    )

    fig.update_xaxes(
        title="Date",
        rangeslider=dict(visible=True),  # Enable zoom slider
        type="date",
    )
    fig.update_yaxes(title="Conversations", secondary_y=False)
    fig.update_yaxes(title="Duration (mins) / Messages", secondary_y=True)

    st.plotly_chart(fig, use_container_width=True)


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
    from src.usage_tracker.metrics import estimate_conversation_duration, format_duration

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

    # Sidebar - User Selection
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

    # Date range selection
    st.sidebar.header("📅 Date Range")

    date_ranges = get_date_ranges()
    selected_range_name = st.sidebar.selectbox(
        "Time period",
        options=list(date_ranges.keys()),
        index=0,
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
        st.info("👈 Select one or more users from the sidebar to view their usage data")

        # Show summary stats
        st.subheader("📈 Quick Stats")
        st.write(f"**Total users in system:** {len(all_users)}")

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

    st.divider()

    # Tabs for different views
    tab1, tab2, tab3, tab4 = st.tabs(
        [
            "📈 Timeline",
            "💬 Chat Analysis",
            "📁 Projects",
            "📄 Export",
        ]
    )

    with tab1:
        render_timeline_chart(metrics)

        # Timeline AI Insights
        try:
            settings = get_settings()
            if settings.llm.is_configured:
                if st.button("🤖 Analyze Timeline", key="timeline_insights_btn"):
                    with st.spinner("Analyzing patterns..."):
                        timeline_insights = generate_timeline_insights(metrics)
                        st.session_state["timeline_insights"] = timeline_insights

                if "timeline_insights" in st.session_state:
                    st.markdown(st.session_state["timeline_insights"])
        except Exception as e:
            st.error(f"Failed: {e}")

    with tab2:
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

    with tab3:
        col1, col2, col3 = st.columns(3)
        with col1:
            st.metric("Total Projects", metrics.projects.total_projects)
        with col2:
            st.metric("Active Projects", metrics.projects.active_projects)
        with col3:
            st.metric("Avg Convos/Project", f"{metrics.projects.avg_conversations_per_project:.1f}")

        render_projects_table(usage_data)

    with tab4:
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
