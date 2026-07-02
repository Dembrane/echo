import { useCallback, useEffect, useState } from "react";

const WIDTH_KEY = "dembrane.sidebar.width";
const EXPANDED_KEY = "dembrane.sidebar.expanded";
const COLLAPSED_KEY = "dembrane.sidebar.collapsed";
const LOCAL_STATE_EVENT = "dembrane.sidebar.local-state";

export const SIDEBAR_WIDTH_DEFAULT = 240;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 320;

export interface SidebarState {
	width: number;
	expandedNodes: Record<string, boolean>;
	setWidth: (n: number) => void;
	isNodeExpanded: (id: string) => boolean;
	setNodeExpanded: (id: string, open: boolean) => void;
	toggleNode: (id: string) => void;
	collapsed: boolean;
	setCollapsed: (collapsed: boolean) => void;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function readLS<T>(key: string, fallback: T): T {
	if (typeof window === "undefined") return fallback;
	try {
		const raw = window.localStorage.getItem(key);
		if (raw == null) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function writeLS<T>(key: string, value: T): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// quota or private mode — silently ignore
	}
}

function emitLocalStateChange<T>(key: string, value: T): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent(LOCAL_STATE_EVENT, { detail: { key, value } }),
	);
}

// Small inline localStorage state hook. Syncs same-page subscribers via a
// custom event and open tabs via the storage event.
function useLocalState<T>(
	key: string,
	initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
	const [value, setValue] = useState<T>(() => readLS(key, initial));

	useEffect(() => {
		const onStorage = (e: StorageEvent) => {
			if (e.key !== key) return;
			if (e.newValue == null) {
				setValue(initial);
				return;
			}
			try {
				setValue(JSON.parse(e.newValue) as T);
			} catch {
				/* ignore */
			}
		};
		const onLocalState = (e: Event) => {
			const detail = (e as CustomEvent<{ key: string; value: T }>).detail;
			if (detail?.key !== key) return;
			setValue(detail.value);
		};
		window.addEventListener("storage", onStorage);
		window.addEventListener(LOCAL_STATE_EVENT, onLocalState);
		return () => {
			window.removeEventListener("storage", onStorage);
			window.removeEventListener(LOCAL_STATE_EVENT, onLocalState);
		};
	}, [key, initial]);

	const set = useCallback(
		(next: T | ((prev: T) => T)) => {
			setValue((prev) => {
				const resolved =
					typeof next === "function" ? (next as (p: T) => T)(prev) : next;
				writeLS(key, resolved);
				queueMicrotask(() => emitLocalStateChange(key, resolved));
				return resolved;
			});
		},
		[key],
	);

	return [value, set];
}

	export function useSidebarState(): SidebarState {
		const [width, setWidthRaw] = useLocalState<number>(
			WIDTH_KEY,
			SIDEBAR_WIDTH_DEFAULT,
		);
		const [collapsed, setCollapsedRaw] = useLocalState<boolean>(
			COLLAPSED_KEY,
			false,
		);
		const [expandedNodes, setExpandedNodes] = useLocalState<
			Record<string, boolean>
		>(EXPANDED_KEY, {});

		const setWidth = useCallback(
			(n: number) => setWidthRaw(clamp(n, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)),
			[setWidthRaw],
		);

		const isNodeExpanded = useCallback(
			(id: string) => expandedNodes[id] === true,
			[expandedNodes],
		);

		const setNodeExpanded = useCallback(
			(id: string, open: boolean) => {
				setExpandedNodes((prev) => ({ ...prev, [id]: open }));
			},
			[setExpandedNodes],
		);

		const toggleNode = useCallback(
			(id: string) => {
				setExpandedNodes((prev) => ({ ...prev, [id]: !prev[id] }));
			},
			[setExpandedNodes],
		);

		return {
			expandedNodes,
			isNodeExpanded,
			setNodeExpanded,
			setWidth,
			toggleNode,
			width: collapsed ? 0 : width,
			collapsed,
			setCollapsed: setCollapsedRaw,
		};
	}
