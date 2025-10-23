# Frontend Query Optimization Summary

## Overview
This document summarizes the optimizations made to frontend queries to reduce unnecessary data fetching from the database.

## Changes Made

### 1. Projects Query (`useInfiniteProjects`)
**File:** `frontend/src/routes/project/ProjectsHome.tsx`

**Before:**
```typescript
fields: ["count(conversations)", "*"]
```

**After:**
```typescript
fields: ["id", "name", "updated_at", "count(conversations)"]
```

**Impact:** Reduced from fetching ALL project fields to only 4 specific fields.
**Used in:** Project list view (`ProjectListItem` component)

---

### 2. Conversations List Query (`useConversationsByProjectId` & `useInfiniteConversationsByProjectId`)
**File:** `frontend/src/components/conversation/hooks/index.ts`

**Before:**
- Fetched all fields from `CONVERSATION_FIELDS_WITHOUT_PROCESSING_STATUS` (25+ fields)
- Fetched all chunk fields with `["*"]`
- Fetched all tag fields including `created_at`

**After:**
```typescript
// New minimal fields list for conversation lists
CONVERSATION_LIST_FIELDS = [
  "id",
  "created_at",
  "participant_name",
  "participant_email",
  "source",
  "duration",
  "tags",
  "chunks",
]

// Only fetch specific chunk fields for live status
{ chunks: ["source", "timestamp", "created_at"] }

// Only fetch necessary tag fields
{ tags: [{ project_tag_id: ["id", "text"] }] }

// Reduced chunk limit from 1 to 25 when not loading all chunks
```

**Impact:** 
- Reduced fields from 25+ to 8 base fields
- Reduced chunk fields from all fields to only 3 fields
- Removed unnecessary `created_at` from tags
- More reasonable chunk limit (25 instead of 1)

**Used in:** Conversation list views (`ConversationAccordion`, `ConversationStatusIndicators`)

---

### 3. Conversation Detail Query (`useConversationById`)
**File:** `frontend/src/components/conversation/hooks/index.ts`

**Before:**
- Fetched all fields from `CONVERSATION_FIELDS_WITHOUT_PROCESSING_STATUS` (25+ fields)
- Included `created_at` in tag fields

**After:**
```typescript
fields: [
  "id",
  "summary",
  "source",
  "is_finished",
  "participant_name",
  "participant_email",
  { linking_conversations: [...] },
  { linked_conversations: [...] },
  { tags: [{ project_tag_id: ["id", "text"] }] },
  ...(loadConversationChunks ? [{ chunks: ["*"] }] : []),
]
```

**Impact:** Reduced from 25+ fields to 6 base fields + related data
**Used in:** Conversation overview page (`ProjectConversationOverviewRoute`)

---

### 4. Chat Query (`useChat`)
**File:** `frontend/src/components/chat/hooks/index.ts`

**Before:**
```typescript
fields: [
  "*",
  { used_conversations: ["*"] }
]
```

**After:**
```typescript
fields: ["id", "name", "project_id"]
```

**Impact:** 
- Eliminated fetching ALL chat fields
- Removed unnecessary `used_conversations` relation (not used in UI)
- Reduced to only 3 fields

**Used in:** Chat route (`ProjectChatRoute`)

---



## Testing Recommendations

Please test the following user flows to ensure everything works correctly:

1. **Login → Projects:**
   - ✓ Project list displays correctly
   - ✓ Project names and conversation counts show
   - ✓ Last updated timestamps display

2. **Projects → Conversations:**
   - ✓ Conversation list displays correctly
   - ✓ Participant names/emails show
   - ✓ Tags display properly
   - ✓ Live status indicator works
   - ✓ Duration badges show
   - ✓ Source badges (Upload/Text) display

3. **Conversation → Overview:**
   - ✓ Summary displays
   - ✓ Conversation metadata shows
   - ✓ Tags can be edited
   - ✓ Linked conversations display

4. **Conversation → Transcript:**
   - ✓ Transcript chunks load correctly
   - ✓ Audio player works (uses separate query)

5. **Chat:**
   - ✓ Chat name displays
   - ✓ Chat can be renamed
   - ✓ Chat can be deleted
   - ✓ Chat messages work

