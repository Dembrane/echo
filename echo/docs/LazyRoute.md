# Lazy Route Loading System

This system provides a convenient way to implement lazy loading for React Router routes with built-in loading states, error boundaries, and TypeScript support.

## Components

### LazyRoute
A wrapper component that provides Suspense and Error Boundary functionality for lazy-loaded components.

### Helper Functions

#### createLazyRoute()
Use this for components that have **default exports**.

```tsx
// For components exported as: export default function MyComponent() {}
const MyComponent = createLazyRoute(() => import('./MyComponent'));
```

#### createLazyNamedRoute()
Use this for components that have **named exports**.

```tsx
// For components exported as: export const MyComponent = () => {}
const MyComponent = createLazyNamedRoute(
  () => import('./MyComponent'),
  'MyComponent'
);
```

#### createAutoLazyRoute()
Automatically detects export type (experimental).

```tsx
// Tries to auto-detect the export type
const MyComponent = createAutoLazyRoute(() => import('./MyComponent'));

// Or specify the component name for named exports
const MyComponent = createAutoLazyRoute(
  () => import('./MyComponent'),
  'MyComponent'
);
```

## Features

- **Loading State**: Uses Mantine's LoadingOverlay with blur effect
- **Error Handling**: Catches errors with custom Error Boundary
- **TypeScript Support**: Full type safety
- **Flexible**: Supports both default and named exports
- **Performance**: Optimized for Vite bundling

## Usage in Router

```tsx
import { createLazyRoute, createLazyNamedRoute } from './components/common/LazyRoute';

// Default export
const HomePage = createLazyRoute(() => import('./routes/Home'));

// Named export
const LoginPage = createLazyNamedRoute(
  () => import('./routes/auth/Login'),
  'LoginRoute'
);

const router = createBrowserRouter([
  {
    path: "/",
    element: <HomePage />
  },
  {
    path: "/login", 
    element: <LoginPage />
  }
]);
```

## Custom Loading Component

You can provide a custom fallback component:

```tsx
const CustomLoader = () => <div>Loading...</div>;

const MyComponent = createLazyRoute(
  () => import('./MyComponent'),
  CustomLoader
);
```

## Best Practices

1. **Keep layouts as regular imports** - They're used frequently and should be in the main bundle
2. **Use lazy loading for route components** - Split by route for optimal loading
3. **Group related components** - Components used together can be in the same chunk
4. **Monitor bundle sizes** - Use Vite's rollup analysis to check chunk sizes 