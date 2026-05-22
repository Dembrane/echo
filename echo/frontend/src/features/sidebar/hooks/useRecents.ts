import { useCallback, useEffect, useState } from "react";

const KEY = "dembrane.sidebar.recents";
const MAX = 8;

export interface RecentItem {
	kind: "workspace" | "project";
	id: string;
	label: string;
	href: string;
	// Parent label for context, e.g. workspace name on a project entry.
	parent?: string;
	lastVisited: number;
}

function read(): RecentItem[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function write(items: RecentItem[]): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(KEY, JSON.stringify(items));
	} catch {
		// quota / private mode — ignore
	}
}

export function useRecents() {
	const [items, setItems] = useState<RecentItem[]>(() => read());

	useEffect(() => {
		const onStorage = (e: StorageEvent) => {
			if (e.key !== KEY) return;
			setItems(read());
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	const record = useCallback((item: Omit<RecentItem, "lastVisited">) => {
		setItems((prev) => {
			const filtered = prev.filter(
				(p) => !(p.kind === item.kind && p.id === item.id),
			);
			const next = [{ ...item, lastVisited: Date.now() }, ...filtered].slice(
				0,
				MAX,
			);
			write(next);
			return next;
		});
	}, []);

	const clear = useCallback(() => {
		setItems([]);
		write([]);
	}, []);

	return { clear, items, record };
}
