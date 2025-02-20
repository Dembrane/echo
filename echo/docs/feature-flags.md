# Feature Flags

This document describes the feature flag system used in the Echo platform.

## Overview

Feature flags allow granular control over feature availability through environment variables. Each feature can be enabled or disabled independently in both the frontend and backend.

## Available Flags

### Core AI Features
- `ENABLE_REPLY` - Controls AI reply functionality
- `ENABLE_REPORT_GENERATION` - Controls report generation
- `ENABLE_CHAT_TEMPLATES` - Controls chat template system

### Library Features
- `ENABLE_LIBRARY_VIEWS` - Controls views in library
- `ENABLE_LIBRARY_INSIGHTS` - Controls insights functionality
- `ENABLE_IMAGE_GENERATION` - Controls AI image generation

### UI/UX Features
- `ENABLE_CONVERSATION_SUMMARY` - Controls conversation summarization

## Default Values

- All core features are enabled by default
- Optional features are enabled by default but can be disabled as needed
- Development environment has all features enabled

## Usage

### Backend (Python)

```python
from dembrane.config.features import is_feature_enabled

if is_feature_enabled("reply"):
    # Reply feature is enabled
    ...
```

### Frontend (TypeScript/React)

```typescript
import { useFeature } from '@/config/features';

function MyComponent() {
  const isReplyEnabled = useFeature('reply');
  
  if (isReplyEnabled) {
    // Reply feature is enabled
    ...
  }
}
```

## Environment Configuration

### Local Development

Set feature flags in your local `.env` file:

```bash
# Core Features
ENABLE_REPLY=1
ENABLE_REPORT_GENERATION=1
ENABLE_CHAT_TEMPLATES=1

# Library Features
ENABLE_LIBRARY_VIEWS=1
ENABLE_LIBRARY_INSIGHTS=1
ENABLE_IMAGE_GENERATION=1

# UI/UX Features
ENABLE_CONVERSATION_SUMMARY=1
```

### Docker Deployment

Feature flags are configured in the `docker-compose.yml` file and can be overridden through environment variables:

```yaml
environment:
  - ENABLE_REPLY=${ENABLE_REPLY:-1}
  - ENABLE_REPORT_GENERATION=${ENABLE_REPORT_GENERATION:-1}
  # ... other feature flags
```

## Testing

When implementing new features or modifying existing ones:

1. Test the feature with its flag enabled and disabled
2. Verify graceful degradation when features are disabled
3. Ensure dependent features handle disabled prerequisites appropriately

## Best Practices

1. Always check feature flags before executing feature-specific code
2. Use the provided helper functions/hooks instead of checking environment variables directly
3. Document any new feature flags in this file
4. Keep feature dependencies minimal and explicit
5. Test both enabled and disabled states 