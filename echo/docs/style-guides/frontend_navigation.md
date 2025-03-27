# Frontend Navigation Style Guide and Documentation

## Quick Reference
- **Navigation Components**: `I18nLink`, `useI18nNavigate`
- **Internationalization**: Automatic language prefix handling
- **Router Integration**: React Router DOM
- **Language Support**: Multi-language routing support
- **URL Structure**: `/{language}/{route}`

## Key Features

### 1. Internationalized Navigation
- Automatic language prefix handling
- Consistent URL structure across languages
- Fallback to default language
- Language persistence across navigation

### 2. Navigation Components
- `I18nLink`: Drop-in replacement for React Router's `Link`
- `useI18nNavigate`: Hook for programmatic navigation
- Automatic language prefix injection
- Support for relative paths

### 3. URL Patterns
- Language prefix: `/{language}/...`
- Consistent across all routes
- Maintains browser history
- SEO-friendly URLs

## Core Technologies
- **React Router DOM** for base routing
- **Custom `I18nLink` component** for language-aware links
- **`useI18nNavigate` hook** for programmatic navigation
- **Language detection** from URL and fallback mechanisms

## Basic Usage

### Common Navigation Imports
```typescript
import { I18nLink } from "@/components/common/i18nLink";
import { useI18nNavigate } from "@/lib/useI18nNavigate";
import { SUPPORTED_LANGUAGES } from "@/config";
```

### Link Component Usage
```tsx
// Basic usage
<I18nLink to="/dashboard">Dashboard</I18nLink>

// With dynamic parameters
<I18nLink to={`/project/${projectId}`}>Project Details</I18nLink>

// Relative navigation
<I18nLink to="..">Back</I18nLink>
```

### Programmatic Navigation
```tsx
const navigate = useI18nNavigate();

// Basic navigation
navigate("/dashboard");

// With dynamic parameters
navigate(`/project/${projectId}`);

// Going back
navigate(-1);
```

## Navigation Primitives

### I18nLink Component
The `I18nLink` component extends React Router's `Link` component with automatic language prefix handling:

```tsx
export const I18nLink: React.FC<LinkProps> = ({ to, ...props }) => {
  const { language } = useParams<{ language?: string }>();
  const { language: i18nLanguage } = useLanguage();

  const finalLanguage = language ?? i18nLanguage;
  
  // Handle relative navigation
  if (to.toString() === "..") {
    return <Link to={to} {...props} />;
  }

  // Add language prefix if needed
  const languagePrefix = finalLanguage ? `/${finalLanguage}` : "";
  const modifiedTo = typeof to === "string" ? `${languagePrefix}${to}` : to;

  return <Link className="" to={modifiedTo} {...props} />;
};
```

### useI18nNavigate Hook
The `useI18nNavigate` hook provides programmatic navigation with language support:

```tsx
export function useI18nNavigate() {
  const navigate = useNavigate();
  const { language } = useParams<{ language?: string }>();
  const { language: i18nLanguage } = useLanguage();

  const finalLanguage = language ?? i18nLanguage;

  return (to: To, options?: NavigateOptions) => {
    if (typeof to === "number") {
      navigate(to, options);
      return;
    }

    const languagePrefix = finalLanguage ? `/${finalLanguage}` : "";
    navigate(`${languagePrefix}${to}`, options);
  };
}
```

## Best Practices

1. **Always Use I18nLink**
   - Use `I18nLink` instead of React Router's `Link`
   - Ensures consistent language handling
   - Maintains URL structure

2. **URL Structure**
   - Keep URLs language-agnostic in code
   - Let navigation components handle language prefixes
   - Use relative paths when appropriate

3. **Language Handling**
   - Don't manually append language prefixes
   - Use navigation primitives consistently
   - Let the system handle language fallbacks

4. **Route Definitions**
   - Define routes without language prefix
   - Use dynamic parameters where needed
   - Keep route structure flat and clear

## Implementation Patterns

### Basic Navigation
```tsx
// Good
<I18nLink to="/dashboard">Dashboard</I18nLink>

// Bad - Don't manually add language prefix
<Link to="/en/dashboard">Dashboard</Link>
```

### Dynamic Routes
```tsx
// Good
<I18nLink to={`/project/${id}/settings`}>Settings</I18nLink>

// Good - Programmatic navigation
const navigate = useI18nNavigate();
navigate(`/project/${id}/settings`);
```

### Relative Navigation
```tsx
// Good - Going up one level
<I18nLink to="..">Back</I18nLink>

// Good - Relative to current route
<I18nLink to="../settings">Settings</I18nLink>
```

## Common Patterns

### Language-Aware Navigation
```tsx
const LanguageSwitcher = () => {
  const navigate = useI18nNavigate();
  const currentPath = useLocation().pathname;
  
  return (
    <Select
      data={SUPPORTED_LANGUAGES}
      onChange={(newLang) => {
        // The useI18nNavigate hook will handle the language prefix
        navigate(currentPath);
      }}
    />
  );
};
```

### Protected Routes
```tsx
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const navigate = useI18nNavigate();
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) {
      // Will maintain language prefix
      navigate("/login");
    }
  }, [isAuthenticated, navigate]);

  return isAuthenticated ? children : null;
};
```

## What Not to Do

1. **Don't Manually Add Language Prefixes**
   ```tsx
   // Bad
   <Link to="/en/dashboard">Dashboard</Link>
   
   // Good
   <I18nLink to="/dashboard">Dashboard</I18nLink>
   ```

2. **Don't Use Raw useNavigate**
   ```tsx
   // Bad
   const navigate = useNavigate();
   navigate("/en/dashboard");
   
   // Good
   const navigate = useI18nNavigate();
   navigate("/dashboard");
   ```

3. **Don't Hardcode Languages in Routes**
   ```tsx
   // Bad
   const routes = [
     { path: "/en/dashboard", element: <Dashboard /> },
     { path: "/fr/dashboard", element: <Dashboard /> },
   ];
   
   // Good
   const routes = [
     { path: "/:language/dashboard", element: <Dashboard /> },
   ];
   ```

4. **Don't Skip Language Handling**
   ```tsx
   // Bad
   const MyComponent = () => {
     const navigate = useNavigate();
     const handleClick = () => navigate("/settings");
   };
   
   // Good
   const MyComponent = () => {
     const navigate = useI18nNavigate();
     const handleClick = () => navigate("/settings");
   };
   ```

## Performance Considerations

1. **Route Code Splitting**
   - Use React.lazy for route components
   - Implement proper loading states
   - Handle language bundles efficiently

2. **Navigation State Management**
   - Minimize unnecessary re-renders
   - Use proper memoization
   - Handle navigation events efficiently

3. **Language Bundle Loading**
   - Implement lazy loading for language files
   - Cache language resources
   - Handle loading states appropriately

## Accessibility

1. **Proper Link Text**
   - Use descriptive link text
   - Avoid generic "click here" text
   - Include proper ARIA labels when needed

2. **Keyboard Navigation**
   - Ensure proper focus management
   - Implement skip links
   - Handle focus restoration after navigation

3. **Screen Reader Support**
   - Announce page changes
   - Provide proper landmarks
   - Include proper heading structure

## URL Structure Guidelines

1. **Keep URLs Clean**
   - Use kebab-case for URLs
   - Avoid query parameters when possible
   - Keep URL structure shallow

2. **SEO Considerations**
   - Use semantic URLs
   - Implement proper redirects
   - Handle language variants properly

3. **Error Handling**
   - Implement proper 404 handling
   - Handle invalid language codes
   - Provide helpful error messages
``` 