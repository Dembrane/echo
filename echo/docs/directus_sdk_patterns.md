# Directus SDK Usage Patterns and Examples

This document provides comprehensive examples of Directus SDK usage patterns found in the Echo codebase, including Python, TypeScript, and cURL patterns with important exceptions and edge cases.

## Table of Contents

1. [Python SDK Patterns](#python-sdk-patterns)
2. [TypeScript SDK Patterns](#typescript-sdk-patterns)
3. [cURL Patterns](#curl-patterns)
4. [Type Definitions](#type-definitions)
5. [Important Notes and Edge Cases](#important-notes-and-edge-cases)

## Python SDK Patterns

### Setup and Import

```python
from directus_py_sdk import DirectusClient
from dembrane.config import DIRECTUS_TOKEN, DIRECTUS_BASE_URL

# Initialize client
directus = DirectusClient(url=DIRECTUS_BASE_URL, token=DIRECTUS_TOKEN)
```

(or) you can import it from dembrane.directus module

### Get Items (Read Multiple)

**IMPORTANT**: Python SDK returns lists directly, NO need for `[0]` indexing unless you want the first item specifically.

```python
# Basic get_items - returns a list
conversations = directus.get_items(
    "conversation",
    {
        "query": {
            "filter": {
                "is_finished": False,
                "chunks": {
                    "_none": {
                        "timestamp": {
                            "_gte": timestamp.isoformat()
                        }
                    }
                }
            },
            "fields": ["id"],
            "limit": -1,  # -1 means no limit
        },
    },
)
# conversations is already a list, iterate directly
for conversation in conversations:
    print(conversation["id"])
```

```python
# Get items with relationships and deep queries
response = directus.get_items(
    "conversation",
    {
        "query": {
            "filter": {"conversation_id": conversation_id},
            "fields": ["*"],
            "deep": {"chunks": {"_sort": "-timestamp"}},
            "limit": 1,
        },
    },
)
# To get first item from list: response[0]
first_conversation = response[0] if response else None
```

### Create Item

**IMPORTANT**: Returns `{"data": {...}}` - you need to access `["data"]` to get the actual item.

```python
# Single item creation
new_conversation = directus.create_item(
    "conversation",
    item_data={
        "id": generate_uuid(),
        "project_id": project_id,
        "participant_name": name,
        "participant_email": email,
        "tags": {
            "create": [
                {"project_tag_id": tag_id}
                for tag_id in tag_id_list
            ],
        },
    },
)["data"]  # IMPORTANT: Access ["data"] to get the actual item

# Create with relationships
new_chunk = directus.create_item(
    "conversation_chunk", 
    item_data={
        "conversation_id": conversation_id,
        "path": file_path,
        "timestamp": timestamp.isoformat(),
        "source": "PORTAL_AUDIO"
    }
)["data"]
```

### Update Item

```python
# Update item
directus.update_item(
    "conversation",
    conversation_id,
    {"is_finished": True, "summary": "Updated summary"}
)
```

### Delete Item

```python
# Delete item
directus.delete_item("conversation_chunk", chunk_id)
```

### Error Handling Context Manager

```python
from contextlib import contextmanager
import requests

@contextmanager
def directus_client_context():
    try:
        yield directus
    except Exception as e:
        if isinstance(e, requests.exceptions.ConnectionError):
            raise DirectusServerError(e) from e
        if isinstance(e, AssertionError):
            raise DirectusBadRequest(e) from e
        raise DirectusGenericException(e) from e

# Usage
with directus_client_context() as client:
    conversation = client.get_items("conversation", {"query": {"filter": {"id": conversation_id}}})
```

## TypeScript SDK Patterns

### Setup and Import

```typescript
import { authentication, createDirectus, rest } from "@directus/sdk";
import { 
  createItem, 
  deleteItem, 
  readItem, 
  readItems, 
  updateItem 
} from "@directus/sdk";

// Initialize clients
export const directus = createDirectus<CustomDirectusTypes>(DIRECTUS_PUBLIC_URL)
  .with(authentication("session", { credentials: "include", autoRefresh: true }))
  .with(rest({ credentials: "include" }));

export const directusParticipant = createDirectus<CustomDirectusTypes>(DIRECTUS_PUBLIC_URL)
  .with(rest());
```

### Read Items (Get Multiple)

```typescript
// Basic readItems
const conversations = await directus.request<Conversation[]>(
  readItems("conversation", {
    filter: {
      project_id: { _eq: projectId },
      is_finished: { _eq: true }
    },
    fields: ["id", "is_finished", "summary", "participant_name"],
    sort: "-created_at"
  })
);

// With relationships and deep queries
const projects = await directus.request<Project[]>(
  readItems("project", {
    fields: [
      "*",
      { tags: ["id", "created_at", "text", "sort"] }
    ],
    deep: {
      tags: { _sort: "sort" }
    },
    limit: 15,
    offset: pageParam * 15
  })
);
```

### Read Single Item

```typescript
// Read single item by ID
const project = await directus.request<Project>(
  readItem("project", projectId, {
    fields: [
      "*",
      { tags: ["id", "created_at", "text", "sort"] }
    ]
  })
);
```

### Create Item

```typescript
// Create single item
const newProject = await directus.request<Project>(
  createItem("project", {
    name: "New Project",
    directus_user_id: userId,
    is_conversation_allowed: true
  })
);

// Create with relationships
const newTag = await directus.request<ProjectTag>(
  createItem("project_tag", {
    project_id: { id: projectId, directus_user_id: userId },
    text: "New Tag",
    sort: 1
  })
);
```

### Update Item

```typescript
// Update item
const updatedProject = await directus.request<Project>(
  updateItem("project", projectId, {
    name: "Updated Name",
    context: "Updated context"
  })
);
```

### Delete Item

```typescript
// Delete item
await directus.request(deleteItem("project", projectId));
```

### React Query Integration

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

// Query hook
export const useProjectById = ({ projectId }: { projectId: string }) => {
  return useQuery({
    queryKey: ["projects", projectId],
    queryFn: () => directus.request<Project>(readItem("project", projectId))
  });
};

// Mutation hook
export const useCreateProjectMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<Project>) =>
      directus.request(createItem("project", payload)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });
};
```

### Content CMS Usage (Separate Instance)

```typescript
// Separate Directus instance for content
export const directusContent = createDirectus<CustomDirectusTypesContent>(
  DIRECTUS_CONTENT_PUBLIC_URL
).with(rest());

// Usage for content queries
const tutorials = await directusContent.request<EchoPortalTutorial[]>(
  readItems("echo__portal_tutorial", {
    filter: { slug: { _eq: slug } },
    deep: { cards: { _sort: "sort" } },
    fields: [
      "id",
      "slug", 
      "count(cards)",
      {
        cards: [
          "id",
          "sort",
          { echo__portal_tutorial_card_id: ["*", { translations: ["*"] }] }
        ]
      }
    ]
  })
);
```

## cURL Patterns

### Authentication

```bash
# Using static token
curl -H "Authorization: Bearer YOUR_DIRECTUS_TOKEN" \
     -H "Content-Type: application/json" \
     https://your-directus-instance.com/items/collection

# Using session (after login)
curl -H "Cookie: directus_session_token=TOKEN" \
     -H "Content-Type: application/json" \
     https://your-directus-instance.com/items/collection
```

### GET Items (List)

```bash
# Basic list
curl "https://your-directus-instance.com/items/conversation" \
  -H "Authorization: Bearer TOKEN"

# With filters and fields
curl "https://your-directus-instance.com/items/conversation?\
filter[is_finished][_eq]=false&\
fields[]=id&fields[]=participant_name&\
limit=10&\
sort=-created_at" \
  -H "Authorization: Bearer TOKEN"

# Complex filter with relationships
curl "https://your-directus-instance.com/items/conversation?\
filter[project_id][is_conversation_allowed][_eq]=true&\
filter[chunks][_none][timestamp][_gte]=2024-01-01T00:00:00Z&\
fields[]=*&\
deep[chunks][_sort]=-timestamp" \
  -H "Authorization: Bearer TOKEN"
```

### GET Single Item

```bash
# Get by ID
curl "https://your-directus-instance.com/items/conversation/uuid-here" \
  -H "Authorization: Bearer TOKEN"

# With relationships
curl "https://your-directus-instance.com/items/project/uuid-here?\
fields[]=*&\
fields[tags][]=id&fields[tags][]=text&\
deep[tags][_sort]=sort" \
  -H "Authorization: Bearer TOKEN"
```

### POST Create Item

```bash
# Create single item
curl -X POST "https://your-directus-instance.com/items/conversation" \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "uuid-here",
    "project_id": "project-uuid",
    "participant_name": "John Doe",
    "participant_email": "john@example.com",
    "is_finished": false
  }'

# Create with relationships
curl -X POST "https://your-directus-instance.com/items/conversation" \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "uuid-here",
    "project_id": "project-uuid",
    "participant_name": "John Doe",
    "tags": {
      "create": [
        {"project_tag_id": "tag-uuid-1"},
        {"project_tag_id": "tag-uuid-2"}
      ]
    }
  }'
```

### PATCH Update Item

```bash
# Update item
curl -X PATCH "https://your-directus-instance.com/items/conversation/uuid-here" \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "is_finished": true,
    "summary": "Conversation completed"
  }'
```

### DELETE Item

```bash
# Delete single item
curl -X DELETE "https://your-directus-instance.com/items/conversation/uuid-here" \
  -H "Authorization: Bearer TOKEN"

# Delete multiple items
curl -X DELETE "https://your-directus-instance.com/items/conversation" \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '["uuid-1", "uuid-2", "uuid-3"]'
```

## Type Definitions

The codebase uses a comprehensive type system defined in `typesDirectus.d.ts`:

```typescript
// Main collections
type Conversation = {
  id: string;
  project_id: string | Project;
  participant_name?: string | null;
  participant_email?: string | null;
  is_finished?: boolean | null;
  summary?: string | null;
  chunks: any[] | ConversationChunk[];
  // ... other fields
};

type Project = {
  id: string;
  name?: string | null;
  directus_user_id?: string | DirectusUsers | null;
  conversations: any[] | Conversation[];
  tags: any[] | ProjectTag[];
  // ... other fields
};

// Type mapping for collections
type CustomDirectusTypes = {
  conversation: Conversation[];
  project: Project[];
  project_tag: ProjectTag[];
  conversation_chunk: ConversationChunk[];
  // ... all other collections
};
```

## Important Notes and Edge Cases

### Python SDK Specifics

1. **Return Types**: 
   - `get_items()` returns a list directly
   - `create_item()` returns `{"data": item}` - always access `["data"]`
   - `update_item()` returns the updated item directly

2. **First Item Access**:
   ```python
   # CORRECT: Get first item from list
   items = directus.get_items("collection", query)
   first_item = items[0] if items else None
   
   # WRONG: Don't assume [0] is always needed
   ```

3. **Query Structure**:
   ```python
   # All queries must be wrapped in "query" key
   directus.get_items("collection", {
       "query": {  # This wrapper is required
           "filter": {...},
           "fields": [...],
           "limit": 10
       }
   })
   ```

### TypeScript SDK Specifics

1. **Type Safety**: Always specify return types
   ```typescript
   // Good
   const projects = await directus.request<Project[]>(readItems("project", query));
   
   // Bad - no type safety
   const projects = await directus.request(readItems("project", query));
   ```

2. **Deep Queries**: Use for sorting relationships
   ```typescript
   readItems("project", {
     fields: ["*", { tags: ["*"] }],
     deep: { tags: { _sort: "sort" } }  // Sort relationship
   })
   ```

### Common Patterns

1. **Filtering with Relationships**:
   ```typescript
   // Filter by related field
   filter: {
     project_id: {
       is_conversation_allowed: { _eq: true }
     }
   }
   ```

2. **None/Empty Filters**:
   ```typescript
   // Find items without related items in timeframe
   filter: {
     chunks: {
       "_none": {
         timestamp: { "_gte": timestamp }
       }
     }
   }
   ```

3. **Nested Creation**:
   ```typescript
   // Create item with relationships
   createItem("conversation", {
     id: uuid,
     project_id: projectId,
     tags: {
       create: [{ project_tag_id: "tag-id" }]
     }
   })
   ```

### Error Handling

1. **Python**: Use context managers for proper exception handling
2. **TypeScript**: Wrap in try-catch and handle Directus errors appropriately
3. **Always check for empty arrays** before accessing `[0]`

### Performance Considerations

1. **Use `limit: -1`** for unlimited results in Python
2. **Use `fields`** to limit returned data
3. **Use `deep`** for relationship sorting
4. **Consider pagination** for large datasets using `offset` and `limit`

This document captures the real-world usage patterns from the Echo codebase and should serve as a comprehensive reference for generating Directus queries across different SDKs.