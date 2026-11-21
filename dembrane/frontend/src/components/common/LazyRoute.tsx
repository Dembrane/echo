import React, { Suspense } from "react";
import { ErrorBoundary } from "../error/ErrorBoundary";
import { BeautifulLoading } from "./BeautifulLoading";

interface LazyRouteProps {
	children: React.ReactNode;
	fallback?: React.ComponentType;
	/**
	 * What shows when the chunk fails to load or the component throws; the boundary's own
	 * screen when left out. `null` renders nothing, for an optional block inside a page.
	 */
	errorFallback?: React.ReactNode;
}

const DefaultFallback = () => <BeautifulLoading />;

export const LazyRoute: React.FC<LazyRouteProps> = ({
	children,
	fallback: FallbackComponent = DefaultFallback,
	errorFallback,
}) => {
	return (
		<ErrorBoundary fallback={errorFallback}>
			<Suspense fallback={<FallbackComponent />}>{children}</Suspense>
		</ErrorBoundary>
	);
};

// Helper function to create lazy route wrapper for default exports
export const createLazyRoute = <
	P extends object = Record<string, never>,
>(
	importFn: () => Promise<{ default: React.ComponentType<P> }>,
	fallback?: React.ComponentType,
	errorFallback?: React.ReactNode,
) => {
	const LazyComponent = React.lazy(importFn);

	return (props: P) => (
		<LazyRoute fallback={fallback} errorFallback={errorFallback}>
			<LazyComponent {...props} />
		</LazyRoute>
	);
};

// Helper function to create lazy route wrapper for named exports
export const createLazyNamedRoute = <
	P extends object = Record<string, never>,
>(
	importFn: () => Promise<Record<string, unknown>>,
	componentName: string,
	fallback?: React.ComponentType,
	errorFallback?: React.ReactNode,
) => {
	const LazyComponent = React.lazy(async () => {
		const module = await importFn();
		return { default: module[componentName] as React.ComponentType<P> };
	});

	return (props: P) => (
		<LazyRoute fallback={fallback} errorFallback={errorFallback}>
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
