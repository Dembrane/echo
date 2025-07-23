# Modular Component Pattern

## Overview

The monolithic `frontend/src/lib/query.ts` file has been **dissected and removed**. We now follow a modular component pattern where each domain has its own directory with components, hooks, and utilities.

## 🚨 Important Changes

- **`query.ts` no longer exists** - all functionality moved to modular directories
- **New import patterns** - hooks imported from component directories
- **Domain-based organization** - related functionality grouped together

## Directory Structure

Each component domain follows this pattern:

```
frontend/src/components/{domain}/
|
├── ComponentName.tsx         # React components
├── hooks/
│   └── index.ts              # Domain-specific React Query hooks
└── utils/
    └── index.ts              # Domain-specific utilities
```

## Where to Find Functionality

### Component Domains
- **Participant**: `@/components/participant/hooks`
- **Project**: `@/components/project/hooks`
- **Chat**: `@/components/chat/hooks`
- **Auth**: `@/components/auth/hooks`
and so on...

## Import Patterns

### ❌ Old Way (No longer works)
```typescript
import { useProjectById } from '@/lib/query';
```

### ✅ New Way
```typescript
import { useProjectById } from '@/components/project/hooks';
```

## Creating New Components

### 1. Create Directory Structure
```bash
frontend/src/components/{domain}/
├── hooks/
│   └── index.ts
└── utils/
    └── index.ts
```

### 2. Export Hooks
```typescript
// frontend/src/components/{domain}/hooks/index.ts
export const useDomainQuery = () => {
  // Implementation
};

export const useDomainMutation = () => {
  // Implementation
};
```

### 3. Import in Components
```typescript
import { useDomainQuery, useDomainMutation } from '@/components/{domain}/hooks';
```

## Guidelines

### 1. **Organization**
- Keep related functionality together
- Use descriptive names that indicate the domain
- Export all hooks from `hooks/index.ts`

### 2. **File Naming**
- Components: `PascalCase.tsx`
- Hooks/Utils/Types: `index.ts` (within respective directories)

### 3. **Code Structure**
- Group mutations and queries logically
- Add JSDoc comments for complex functions
- Follow existing patterns in the codebase

## Troubleshooting

### "Cannot find module '@/lib/query'"
- The file no longer exists
- Find the hook in the appropriate component directory
- Use the new import pattern

### "Hook not found"
- Search the codebase for the hook name
- Check component directories for the relevant domain
- Look in shared library files

### "Import path error"
- Ensure you're using the correct path format
- Check that the hook is exported from the index.ts file

## Benefits

- **Better Organization**: Related functionality grouped together
- **Easier Navigation**: Find specific features quickly
- **Reduced Conflicts**: Less merge conflicts between developers
- **Clear Ownership**: Each domain has its own space
- **Improved Testing**: Test individual domains in isolation
- **Better Scalability**: Easy to add new domains

## Migration Checklist

When working with existing code or creating new features:

- [ ] Check if functionality belongs in a specific component domain
- [ ] Use the appropriate import path for hooks
- [ ] Follow the established directory structure
- [ ] Keep related functionality grouped together
- [ ] Test that imports work correctly
- [ ] Verify that the component follows the modular pattern 