# Skill: Fetch Transcript from Directus

## When to Use
When you need to retrieve conversation transcripts from Dembrane's Directus backend.

## Steps

### 1. Find the Project
```
mcp__directus__items
action: read
collection: project
query: {
  "fields": ["id", "name"],
  "filter": {"name": {"_icontains": "PROJECT_NAME"}}
}
```

### 2. Find Conversations
```
mcp__directus__items
action: read
collection: conversation
query: {
  "fields": ["id", "participant_name", "created_at"],
  "filter": {
    "_and": [
      {"project_id": {"_eq": "PROJECT_ID"}},
      {"participant_name": {"_icontains": "SEARCH_TERM"}}
    ]
  },
  "sort": ["-created_at"],
  "limit": 5
}
```

### 3. Fetch Chunks (The Transcript)
```
mcp__directus__items
action: read
collection: conversation_chunk
query: {
  "fields": ["id", "timestamp", "transcript"],
  "filter": {"conversation_id": {"_eq": "CONVERSATION_ID"}},
  "sort": ["timestamp"],
  "limit": 100
}
```

### 4. Concatenate
Join all `chunk.transcript` values in timestamp order to get the full transcript.

## Example
To get the latest retrospective:
- Project: "Product meetings" (ID: 2b912177-abe0-444a-aa40-240d3313b2f1)
- Search: participant_name contains "retro"
- Sort: -created_at (most recent first)

## Notes
- Chunks are sorted ascending by timestamp for correct order
- Large conversations may have 50-100+ chunks
- The `transcript` field is plain text (already processed from audio)
