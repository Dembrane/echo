import React, { Suspense } from "react";
import { LoadingOverlay, Box } from "@mantine/core";
import { ErrorBoundary } from "../error/ErrorBoundary";

interface LazyRouteProps {
  children: React.ReactNode;
  fallback?: React.ComponentType;
}

const DefaultFallback = () => (
  <Box pos="relative" h="100%">
    <LoadingOverlay visible={true} overlayProps={{ radius: "sm", blur: 2 }} />
  </Box>
);

export const LazyRoute: React.FC<LazyRouteProps> = ({
  children,
  fallback: FallbackComponent = DefaultFallback,
}) => {
  return (
    <ErrorBoundary>
      <Suspense fallback={<FallbackComponent />}>{children}</Suspense>
    </ErrorBoundary>
  );
};

// Helper function to create lazy route wrapper for default exports
export const createLazyRoute = (
  importFn: () => Promise<{ default: React.ComponentType<any> }>,
  fallback?: React.ComponentType,
) => {
  const LazyComponent = React.lazy(importFn);

  return (props: any) => (
    <LazyRoute fallback={fallback}>
      <LazyComponent {...props} />
    </LazyRoute>
  );
};

// Helper function to create lazy route wrapper for named exports
export const createLazyNamedRoute = (
  importFn: () => Promise<any>,
  componentName: string,
  fallback?: React.ComponentType,
) => {
  const LazyComponent = React.lazy(async () => {
    const module = await importFn();
    return { default: module[componentName] };
  });

  return (props: any) => (
    <LazyRoute fallback={fallback}>
      <LazyComponent {...props} />
    </LazyRoute>
  );
};

// Helper for tab-based routes - no Suspense since TabsWithRouter handles it
export const createTabLazyRoute = (
  importFn: () => Promise<{ default: React.ComponentType<any> }>,
) => {
  const LazyComponent = React.lazy(importFn);

  return (props: any) => (
    <ErrorBoundary>
      <LazyComponent {...props} />
    </ErrorBoundary>
  );
};

// Helper for tab-based routes with named exports - no Suspense since TabsWithRouter handles it
export const createTabLazyNamedRoute = (
  importFn: () => Promise<any>,
  componentName: string,
) => {
  const LazyComponent = React.lazy(async () => {
    const module = await importFn();
    return { default: module[componentName] };
  });

  return (props: any) => (
    <ErrorBoundary>
      <LazyComponent {...props} />
    </ErrorBoundary>
  );
};

// Alternative: Auto-detect export type helper
export const createAutoLazyRoute = (
  importFn: () => Promise<any>,
  componentName?: string,
  fallback?: React.ComponentType,
) => {
  const LazyComponent = React.lazy(async () => {
    const module = await importFn();

    // If componentName is provided, use named export
    if (componentName) {
      return { default: module[componentName] };
    }

    // If module has default export, use it
    if (module.default) {
      return module;
    }

    // Otherwise, try to find the first function/component export
    const componentExport = Object.values(module).find(
      (exp) => typeof exp === "function",
    );

    if (componentExport) {
      return { default: componentExport as React.ComponentType };
    }

    throw new Error("No valid React component found in module");
  });

  return (props: any) => (
    <LazyRoute fallback={fallback}>
      <LazyComponent {...props} />
    </LazyRoute>
  );
};
