import { useCallback, useEffect, useState } from "react";
import { useV2Me } from "@/hooks/useV2Me";

// Namespaced per user so one user never sees another's recents on a shared browser.
const KEY_PREFIX = "dembrane.sidebar.recents";
// Pre-namespacing global key, purged on load to drop any leaked cross-user entries.
const LEGACY_KEY = "dembrane.sidebar.recents";
const MAX = 8;

function keyFor(userId: string): string {
	return `${KEY_PREFIX}:${userId}`;
}

export interface RecentItem {
	kind: "workspace" | "project";
	id: string;
	label: string;
	href: string;
	// Parent label for context, e.g. workspace name on a project entry.
	parent?: string;
	lastVisited: number;
}

function read(userId: string | null): RecentItem[] {
	if (typeof window === "undefined" || !userId) return [];
	try {
		const raw = window.localStorage.getItem(keyFor(userId));
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function write(userId: string | null, items: RecentItem[]): void {
	if (typeof window === "undefined" || !userId) return;
	try {
		window.localStorage.setItem(keyFor(userId), JSON.stringify(items));
	} catch {
		// quota / private mode — ignore
	}
}

export function useRecents() {
	const { data: me } = useV2Me();
	const userId = me?.directus_user_id ?? null;

	const [items, setItems] = useState<RecentItem[]>([]);

	// Seeded here, not in useState, because the user id isn't known on first render.
	useEffect(() => {
		if (typeof window !== "undefined") {
			try {
				window.localStorage.removeItem(LEGACY_KEY);
			} catch {}
		}
		setItems(read(userId));
	}, [userId]);

	useEffect(() => {
		const onStorage = (e: StorageEvent) => {
			if (!userId || e.key !== keyFor(userId)) return;
			setItems(read(userId));
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [userId]);

	const record = useCallback(
		(item: Omit<RecentItem, "lastVisited">) => {
			if (!userId) return;
			setItems((prev) => {
				const filtered = prev.filter(
					(p) => !(p.kind === item.kind && p.id === item.id),
				);
				const next = [{ ...item, lastVisited: Date.now() }, ...filtered].slice(
					0,
					MAX,
				);
				write(userId, next);
				return next;
			});
		},
		[userId],
	);

	const clear = useCallback(() => {
		setItems([]);
		write(userId, []);
	}, [userId]);

	return { clear, items, record };
}
