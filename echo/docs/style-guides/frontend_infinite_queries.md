# Infinite Queries Style Guide

## Overview

This guide outlines best practices for implementing infinite queries using React Query (v5) in our frontend applications. Infinite queries are essential for handling data that can be paginated or loaded incrementally as the user scrolls, such as lists of projects, conversations, or any other large datasets.

## Core Principles

- **Consistent State Management**: Use React Query's `useInfiniteQuery` hook for managing infinite lists.
- **Efficient Data Fetching**: Leverage debounced values for search inputs to prevent unnecessary network requests.
- **Smooth User Experience**: Implement infinite scrolling with `react-intersection-observer` to load more data seamlessly.
- **Error Handling**: Gracefully handle loading and error states to inform the user appropriately.
- **Clean Code Structure**: Organize your code for readability and maintainability, following our established patterns.

## Implementation Guide

### 1. Setting Up the Infinite Query

Use `useInfiniteQuery` to fetch and manage paginated data.

```typescript
import { useInfiniteQuery } from '@tanstack/react-query';

const {
  data,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  isLoading,
  isError,
  error,
} = useInfiniteQuery(
  ['items', searchTerm], // Query key includes variables like search terms
  ({ pageParam = 1 }) => fetchItems({ page: pageParam, search: searchTerm }), // Fetch function
  {
    getNextPageParam: (lastPage, pages) => lastPage.nextPage ?? false, // Determine if there's a next page
  }
);
```

**Key Points:**

- **Query Key**: Include any variables (like search terms) that affect the data in the query key to ensure proper caching and refetching.
- **Fetch Function**: Should accept `pageParam` and any other necessary parameters.
- **getNextPageParam**: This function informs React Query how to get the next page's params.

### 2. Handling Search Inputs

Use `useState` and `useDebouncedValue` to manage search terms.

```typescript
import { useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';

const [search, setSearch] = useState('');
const [debouncedSearchTerm] = useDebouncedValue(search, 200);
```

Update the search term based on user input:

```jsx
<TextInput
  value={search}
  onChange={(e) => setSearch(e.currentTarget.value)}
  placeholder="Search items..."
/>
```

### 3. Refetching on Search Term Change

When the debounced search term changes, reset the query data to fetch new results.

```typescript
useEffect(() => {
  // Reset the query to fetch new data based on the search term
  queryClient.invalidateQueries(['items']);
}, [debouncedSearchTerm]);
```

### 4. Implementing Infinite Scrolling

Use `react-intersection-observer` to detect when the user scrolls to the bottom and fetch the next page.

```typescript
import { useInView } from 'react-intersection-observer';

const { ref: loadMoreRef, inView } = useInView();

useEffect(() => {
  if (inView && hasNextPage && !isFetchingNextPage) {
    fetchNextPage();
  }
}, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);
```

Attach the `ref` to the sentinel element or the last item in your list:

```jsx
{data.pages.map((page) => (
  page.items.map((item, index) => (
    <ItemComponent
      key={item.id}
      item={item}
      ref={index === page.items.length - 1 ? loadMoreRef : undefined}
    />
  ))
))}
```

### 5. Handling Loading and Error States

Provide feedback to the user during loading or in case of errors.

```jsx
if (isLoading) {
  return <Center><Loader /></Center>;
}

if (isError) {
  return (
    <Alert title="Error" color="red">
      Failed to load items: {error.message}
    </Alert>
  );
}
```

### 6. Rendering the Data

Flatten the pages and render the items.

```typescript
const allItems = data?.pages.flatMap((page) => page.items) ?? [];
```

Render the list:

```jsx
<Stack>
  {allItems.map((item, index) => (
    <ItemComponent
      key={item.id}
      item={item}
      ref={index === allItems.length - 1 ? loadMoreRef : undefined}
    />
  ))}
  {isFetchingNextPage && (
    <Center>
      <Loader />
    </Center>
  )}
</Stack>
```

### 7. Cleanup and Reset on Component Unmount

Reset any states or queries when the component unmounts to prevent memory leaks.

```typescript
useEffect(() => {
  return () => {
    // Cleanup if necessary
  };
}, []);
```

## Example: Integrating Infinite Query with Search

Here's a practical example combining the concepts discussed.

```typescript
import { useState, useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '@mantine/hooks';
import { useInView } from 'react-intersection-observer';
import { TextInput, Loader, Center, Stack } from '@mantine/core';

const InfiniteItemsList = () => {
  const [search, setSearch] = useState('');
  const [debouncedSearchTerm] = useDebouncedValue(search, 200);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useInfiniteQuery(
    ['items', debouncedSearchTerm],
    ({ pageParam = 1 }) => fetchItems({ page: pageParam, search: debouncedSearchTerm }),
    {
      getNextPageParam: (lastPage) => lastPage.nextPage ?? false,
    }
  );

  const { ref: loadMoreRef, inView } = useInView();

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (isLoading) {
    return <Center><Loader /></Center>;
  }

  if (isError) {
    return (
      <Alert title="Error" color="red">
        Failed to load items: {error.message}
      </Alert>
    );
  }

  const allItems = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack>
      <TextInput
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        placeholder="Search items..."
      />

      <Stack>
        {allItems.map((item, index) => (
          <ItemComponent
            key={item.id}
            item={item}
            ref={index === allItems.length - 1 ? loadMoreRef : undefined}
          />
        ))}
        {isFetchingNextPage && (
          <Center>
            <Loader />
          </Center>
        )}
      </Stack>
    </Stack>
  );
};
```

## Best Practices Summary

- **Query Keys**: Always include variables like search terms in your query keys.
- **Debounced Values**: Use `useDebouncedValue` to minimize unnecessary fetches.
- **Infinite Scrolling**: Use `useInView` to trigger `fetchNextPage` when the user scrolls to the bottom.
- **Error and Loading States**: Handle these states to improve user experience.
- **Data Flattening**: Flatten `data.pages` to a single list of items for easy rendering.
- **Avoid Unnecessary `useEffect` Dependencies**: Ensure dependencies are correctly specified to prevent infinite loops.
- **Component Cleanup**: Reset or clean up states when the component unmounts.

## Common Pitfalls to Avoid

1. **Not Including Variables in Query Keys**: Leads to stale or incorrect data being displayed.
2. **Forgetting `getNextPageParam`**: Without this, React Query won't know how to fetch additional pages.
3. **Ref Placement Misalignment**: The `ref` for `useInView` should be attached to the last item or a sentinel element.
4. **Overfetching Due to Lack of Debounce**: Fetching on every keystroke without debounce can overload the API.
5. **Incorrect Effect Dependencies**: Can cause performance issues or infinite loops.
6. **Not Handling Loading States**: Users may think the app is unresponsive if loaders aren't displayed.

## Additional Notes

- **TypeScript Types**: Always define types for your data structures to ensure type safety.
- **UI Consistency**: Use consistent components (e.g., `TextInput`, `Loader`, `Alert`) from our UI library (Mantine).
- **Accessibility**: Ensure that the infinite scrolling implementation is accessible, providing alternatives for users who can't scroll.

## References

- [React Query - Infinite Queries](https://tanstack.com/query/v5/docs/react/guides/infinite-queries)
- [Mantine Hooks - `useDebouncedValue`](https://mantine.dev/hooks/use-debounced-value/)
- [React Intersection Observer](https://github.com/thebuilder/react-intersection-observer)
- [TypeScript Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html)

## Conclusion

Implementing infinite queries following these guidelines ensures optimal performance and a seamless user experience. Adhering to this style guide promotes code consistency and maintainability across the codebase.
