import { Box, LoadingOverlay } from "@mantine/core";
import React, { Suspense } from "react";
import { ErrorBoundary } from "../error/ErrorBoundary";

interface LazyRouteProps {
	children: React.ReactNode;
	fallback?: React.ComponentType;
}

const DefaultFallback = () => (
	<Box pos="relative" h="100%">
		<LoadingOverlay visible={true} overlayProps={{ blur: 2, radius: "sm" }} />
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
export const createLazyRoute = <
	P extends Record<string, unknown> = Record<string, never>,
>(
	importFn: () => Promise<{ default: React.ComponentType<P> }>,
	fallback?: React.ComponentType,
) => {
	const LazyComponent = React.lazy(importFn);

	return (props: P) => (
		<LazyRoute fallback={fallback}>
			<LazyComponent {...props} />
		</LazyRoute>
	);
};

// Helper function to create lazy route wrapper for named exports
export const createLazyNamedRoute = <
	P extends Record<string, unknown> = Record<string, never>,
>(
	importFn: () => Promise<Record<string, unknown>>,
	componentName: string,
	fallback?: React.ComponentType,
) => {
	const LazyComponent = React.lazy(async () => {
		const module = await importFn();
		return { default: module[componentName] as React.ComponentType<P> };
	});

	return (props: P) => (
		<LazyRoute fallback={fallback}>
			<LazyComponent {...props} />
		</LazyRoute>
	);
};

// Helper for tab-based routes - no Suspense since TabsWithRouter handles it
export const createTabLazyRoute = <
	P extends Record<string, unknown> = Record<string, never>,
>(
	importFn: () => Promise<{ default: React.ComponentType<P> }>,
) => {
	const LazyComponent = React.lazy(importFn);

	return (props: P) => (
		<ErrorBoundary>
			<LazyComponent {...props} />
		</ErrorBoundary>
	);
};

// Helper for tab-based routes with named exports - no Suspense since TabsWithRouter handles it
export const createTabLazyNamedRoute = <
	P extends Record<string, unknown> = Record<string, never>,
>(
	importFn: () => Promise<Record<string, unknown>>,
	componentName: string,
) => {
	const LazyComponent = React.lazy(async () => {
		const module = await importFn();
		return { default: module[componentName] as React.ComponentType<P> };
	});

	return (props: P) => (
		<ErrorBoundary>
			<LazyComponent {...props} />
		</ErrorBoundary>
	);
};

// Alternative: Auto-detect export type helper
export const createAutoLazyRoute = <
	P extends Record<string, unknown> = Record<string, never>,
>(
	importFn: () => Promise<Record<string, unknown>>,
	componentName?: string,
	fallback?: React.ComponentType,
) => {
	const LazyComponent = React.lazy(async () => {
		const module = await importFn();

		// If componentName is provided, use named export
		if (componentName) {
			return { default: module[componentName] as React.ComponentType<P> };
		}

		// If module has default export, use it
		if (module.default) {
			return module as { default: React.ComponentType<P> };
		}

		// Otherwise, try to find the first function/component export
		const componentExport = Object.values(module).find(
			(exp) => typeof exp === "function",
		);

		if (componentExport) {
			return { default: componentExport as React.ComponentType<P> };
		}

		throw new Error("No valid React component found in module");
	});

	return (props: P) => (
		<LazyRoute fallback={fallback}>
			<LazyComponent {...props} />
		</LazyRoute>
	);
};
