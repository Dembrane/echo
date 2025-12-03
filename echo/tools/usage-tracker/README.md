# Usage Tracker

A customer usage reporting tool for Dembrane ECHO. Generates insights and reports for sales teams.

## Features

- **User Selection**: Search and select one or multiple users by email/name
- **Time Filters**: MTD, YTD, Last 30/90 days, custom date range
- **Usage Metrics**:
  - Conversation count and total audio duration (with smart estimation)
  - Chat sessions, message counts, and token usage
  - Project and report counts
  - Feature adoption tracking (conversations, chat, reports)
- **Trend Analysis**: Compares current period vs previous period
- **LLM-Powered Insights**: AI-generated summaries highlighting non-obvious patterns
- **Visualizations**: 
  - Activity timeline with zoom/pan slider
  - Word cloud of chat query topics
  - Feature adoption charts
  - Projects table with conversation counts
- **PDF Export**: Professional reports with executive summary and AI insights

## Quick Start

```bash
cd tools/usage-tracker
cp env.example .env
# Edit .env with your credentials
uv sync
uv run streamlit run app.py
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DIRECTUS_BASE_URL` | Your Directus instance URL | ✅ |
| `DIRECTUS_TOKEN` | Admin token with read access to all collections | ✅ |
| `LLM__TEXT_FAST__MODEL` | LiteLLM model identifier (e.g., `gpt-4o-mini`) | For AI insights |
| `LLM__TEXT_FAST__API_KEY` | API key for the LLM provider | For AI insights |
| `LLM__TEXT_FAST__API_BASE` | Base URL for the LLM API | For AI insights |
| `LLM__TEXT_FAST__API_VERSION` | API version (optional, mainly for Azure) | Optional |

### Example Configurations

**OpenAI:**
```env
DIRECTUS_BASE_URL=https://your-directus.com
DIRECTUS_TOKEN=your-token

LLM__TEXT_FAST__MODEL=gpt-4o-mini
LLM__TEXT_FAST__API_KEY=sk-...
LLM__TEXT_FAST__API_BASE=https://api.openai.com/v1
```

**Azure OpenAI:**
```env
LLM__TEXT_FAST__MODEL=azure/gpt-4o-mini
LLM__TEXT_FAST__API_KEY=your-azure-key
LLM__TEXT_FAST__API_BASE=https://your-resource.openai.azure.com
LLM__TEXT_FAST__API_VERSION=2024-02-15-preview
```

## Duration Estimation

For conversations without a recorded duration, we estimate based on:
- **Minimum**: 30 seconds × number of chunks
- **Transcript-based**: ~150 words per minute of speech

The **larger** of these two estimates is used to avoid underestimating.

## Architecture

```
src/usage_tracker/
├── settings.py          # Config from .env (pydantic-settings)
├── directus_client.py   # API client with retry/error handling
├── data_fetcher.py      # Data fetching with batching & aggregation
├── metrics.py           # Metrics calculation & duration estimation
├── llm_insights.py      # LLM-powered insights (via LiteLLM)
└── pdf_export.py        # PDF generation (via ReportLab)
```

## Data Sources

The tool queries these Directus collections:
- `directus_users` - User accounts
- `project` - Projects owned by users
- `conversation` - Conversations within projects
- `conversation_chunk` - Audio chunks (for duration estimation)
- `project_chat` - Chat sessions
- `project_chat_message` - Chat messages
- `project_report` - Generated reports

