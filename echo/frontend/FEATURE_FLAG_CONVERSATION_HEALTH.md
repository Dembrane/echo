# Conversation Health Feature Flag

## Overview
The Conversation Health feature provides real-time monitoring of conversation quality, connection status, and audio feedback. This feature has been made optional through the `VITE_ENABLE_CONVERSATION_HEALTH` environment variable.

## Implementation Details

### Environment Variable
- **Variable Name**: `VITE_ENABLE_CONVERSATION_HEALTH`
- **Type**: String ("1" for enabled, "0" or undefined for disabled)
- **Default**: Disabled (when not set)

### Features Controlled
When enabled, the following features are active:
1. **Connection Health Status**: Visual indicator showing connection health (green for healthy, yellow for unhealthy)
2. **SSE Connection Monitoring**: Real-time monitoring of Server-Sent Events connection
3. **Audio Quality Tips**: Contextual banners for audio issues:
   - High silence detection
   - Cross-talk detection  
   - High noise detection
4. **Conversation Issue Banners**: Dynamic tips to improve audio quality

### Files Modified
1. **`src/config.ts`**: Added the feature flag configuration
2. **`src/components/participant/ParticipantBody.tsx`**: Made all conversation health features conditional
3. **`.env.example`**: Added documentation for the new environment variable

### Usage
To enable the Conversation Health feature:
```bash
# In your .env file
VITE_ENABLE_CONVERSATION_HEALTH=1
```

To disable (default):
```bash
# In your .env file
VITE_ENABLE_CONVERSATION_HEALTH=0
# or simply omit the variable
```

### Backend Requirements
When enabled, this feature requires the following backend endpoint to be available:
- `GET /api/conversations/health/stream?conversation_ids={ids}`

If the endpoint is not available, users will see a connection error message when the feature is enabled.