# AGENTS.md - Usage Tracker

Last updated: 2025-12-01

## Maintenance Protocol

- Read this file before making changes; keep structure consistent and fix stale links/paths immediately.
- Rely on git history for timing; no manual timestamps necessary.
- Auto-correct typos and formatting without asking; escalate only for new patterns or major warnings.
- Ensure instructions stay aligned with repo reality—if something drifts, repair it and note the fix in context.
- Confirm with the team/user before doing anything destructive (e.g., resets, checkouts that drop work) and prefer non-destructive edits when possible.

## When to Ask

- Saw a pattern (≥3 uses)? Ask: "Document this pattern?"
- Fixed a bug? Ask: "Add this to warnings?"
- Completed a repeatable workflow? Ask: "Document this workflow?"
- Resolved confusion for the team? Ask: "Add this clarification?"
- Skip documenting secrets, temporary hacks, or anything explicitly excluded.

---

## Project Snapshot

- **Purpose**: Customer usage analytics tool for Dembrane ECHO sales teams
- **Stack**: Python 3.11+, Streamlit, LiteLLM, Plotly, ReportLab, WordCloud
- **Package Manager**: `uv` (see `pyproject.toml`)
- **Data Source**: Directus API (reads user, project, conversation, chat, report collections)

## Build / Run / Tooling

| Command | Description |
|---------|-------------|
| `uv sync` | Install dependencies |
| `uv run streamlit run app.py` | Run the Streamlit app |
| `uv run python -c "from src.usage_tracker import ..."` | Test imports |

### Development Workflow

1. Copy `env.example` to `.env` and configure Directus + LLM credentials
2. Run `uv sync` to install dependencies
3. Run `uv run streamlit run app.py` to start the app
4. App runs at `http://localhost:8501` by default

## Repeating Patterns (3+ sightings)

### Pattern: Directus Query Structure
All Directus queries follow this structure:
```python
client.get_items(
    "collection_name",
    fields=["field1", "field2", "count(relation)"],
    filter_query={"field": {"_eq": value}},
    sort=["-created_at"],
    limit=-1,  # -1 for all
)
```

### Pattern: Aggregate Count Handling
Directus returns counts in nested format that needs unwrapping:
```python
count = item.get("relation_count", 0)
if isinstance(count, dict):
    count = count.get("count", 0)
if count is None:
    count = 0
```

### Pattern: Date Parsing
All datetime parsing uses `_parse_datetime()` helper that handles multiple ISO formats and null values gracefully.

### Pattern: Batched Fetching
Large collections (conversations, messages) are fetched in batches of 500 to avoid timeouts:
```python
while True:
    batch = client.get_items(..., limit=batch_size, offset=offset)
    if not batch or len(batch) < batch_size:
        break
    offset += batch_size
```

## Module Responsibilities

| Module | Purpose |
|--------|---------|
| `settings.py` | Load config from `.env` using pydantic-settings |
| `directus_client.py` | HTTP client with retry logic, error classes, aggregation support |
| `data_fetcher.py` | High-level data access; dataclasses for User, Project, Conversation, etc. |
| `metrics.py` | Calculate usage metrics, duration estimation, word extraction |
| `llm_insights.py` | Generate AI insights via LiteLLM |
| `pdf_export.py` | Generate PDF reports via ReportLab |
| `app.py` | Main Streamlit application |

## TODO / FIXME / HACK Inventory

_(None currently - project is newly created)_

## Gotchas & Warnings

### Duration Estimation Logic
Conversations may lack a `duration` field. The estimation formula is:
```
estimated = max(30 * chunk_count, transcript_word_count / 150 * 60)
```
- 30 seconds minimum per chunk
- 150 words per minute speech rate
- Uses the **larger** estimate to avoid undercounting

### Directus Token Permissions
The `DIRECTUS_TOKEN` needs read access to:
- `directus_users`
- `project`
- `conversation`
- `conversation_chunk`
- `project_chat`
- `project_chat_message`
- `project_report`

If you see empty data, check token permissions first.

### LLM is Optional
The app works without LLM configuration—AI insights will show a warning but all other features work. PDF export will use a fallback summary.

### Caching Behavior
- User list: cached 5 minutes (`@st.cache_data(ttl=300)`)
- Usage data: cached 1 minute (`@st.cache_data(ttl=60)`)
- Clear cache by refreshing page or restarting app

### Streamlit Session State
AI insights are stored in `st.session_state["insights"]` and persist across reruns until the user selects different users or date ranges.

### Nested Foreign Keys
Directus sometimes returns foreign keys as nested objects `{"id": "...", ...}` instead of plain strings. Always check:
```python
proj_id = item.get("project_id")
if isinstance(proj_id, dict):
    proj_id = proj_id.get("id", "")
```

### Nullable User Fields
Directus users may have `None` for `email`, `first_name`, or `last_name`. Always guard string operations:
```python
if u.email and search_query.lower() in u.email.lower()
```

### Timezone-Aware vs Naive Datetimes
Directus returns timezone-aware datetimes (with `+00:00`). When comparing to `datetime.now()`:
```python
from datetime import timezone
now = datetime.now(timezone.utc)
if last.tzinfo is None:
    last = last.replace(tzinfo=timezone.utc)
delta = now - last
```

### Case-Sensitive Enum Values
The `message_from` field in `project_chat_message` is typed as `"User" | "assistant" | "dembrane"` but actual values may vary in case. Always use case-insensitive comparison:
```python
if msg.message_from and msg.message_from.lower() == "user"
```

### Multilingual Stop Words
The chat analysis uses a comprehensive stop word list covering English, Dutch, German, French, and Spanish. The word extraction also handles accented characters via `\w` regex. If adding new languages, update the `STOP_WORDS` set in `metrics.py`.

## File Change Hotspots

_(Based on initial creation - will be updated as project evolves)_

| File | Change Frequency | Notes |
|------|------------------|-------|
| `app.py` | High | Main UI, likely to change with new features |
| `metrics.py` | Medium | New metrics or calculation changes |
| `data_fetcher.py` | Medium | New data sources or query optimizations |
| `llm_insights.py` | Low | Prompt tuning |
| `pdf_export.py` | Low | Layout/styling changes |
| `directus_client.py` | Low | Stable HTTP client |
| `settings.py` | Low | New env vars only |

## Slow-Moving Files

- `pyproject.toml` - Dependencies, rarely changes
- `env.example` - Template, rarely changes
- `README.md` - Documentation updates

## Dependencies

Key dependencies from `pyproject.toml`:
- `streamlit>=1.40.0` - Web UI
- `litellm>=1.50.0` - LLM abstraction
- `plotly>=5.24.0` - Interactive charts
- `reportlab>=4.2.0` - PDF generation
- `wordcloud>=1.9.0` - Word cloud visualization
- `pydantic>=2.9.0` - Data validation
- `pydantic-settings>=2.6.0` - Settings management

---

_End of AGENTS.md. Update this file when patterns emerge, bugs are fixed, or workflows are established._
