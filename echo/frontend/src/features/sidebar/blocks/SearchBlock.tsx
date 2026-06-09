import { Trans } from "@lingui/react/macro";
import { Modal, TextInput, UnstyledButton } from "@mantine/core";
import { useDebouncedValue, useDisclosure } from "@mantine/hooks";
import {
	Buildings,
	ChatCircle,
	ChatsCircle,
	FileText,
	FolderOpen,
	Gear,
	MagnifyingGlass,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { API_BASE_URL } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useRecents } from "../hooks/useRecents";

interface Hit {
	id: string;
	icon: ComponentType<{ size?: number }>;
	label: string;
	subtitle?: string;
	href: string;
}

// GET /api/home/search — deep search over projects, conversations,
// transcripts and chats, access-scoped server-side.
interface HomeSearchResponse {
	projects: {
		id: string;
		name: string | null;
		workspaceId: string | null;
	}[];
	conversations: {
		id: string;
		projectId: string | null;
		projectName: string | null;
		workspaceId: string | null;
		displayLabel: string;
	}[];
	transcripts: {
		id: string;
		conversationId: string | null;
		conversationLabel: string | null;
		projectId: string | null;
		workspaceId: string | null;
		excerpt: string | null;
	}[];
	chats: {
		id: string;
		projectId: string | null;
		projectName: string | null;
		workspaceId: string | null;
		name: string | null;
	}[];
}

const EMPTY_SEARCH: HomeSearchResponse = {
	chats: [],
	conversations: [],
	projects: [],
	transcripts: [],
};

	export const SearchBlock = () => {
		const [opened, { open, close }] = useDisclosure(false);
		const [q, setQ] = useState("");
		const [activeIndex, setActiveIndex] = useState(0);
		const { workspaces } = useWorkspace();
		const { items: recents } = useRecents();
		const navigate = useNavigate();
		const [shortcut, setShortcut] = useState("⌘K");

		useEffect(() => {
			const isMac = typeof window !== "undefined" && 
				/Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
			if (!isMac) {
				setShortcut("Ctrl K");
			}
		}, []);

	const [debouncedQ] = useDebouncedValue(q.trim(), 250);
	const deepSearch = useQuery({
		enabled: opened && debouncedQ.length >= 2,
		queryFn: async (): Promise<HomeSearchResponse> => {
			const res = await fetch(
				`${API_BASE_URL}/home/search?query=${encodeURIComponent(debouncedQ)}&limit=5`,
				{ credentials: "include" },
			);
			if (!res.ok) return EMPTY_SEARCH;
			return res.json();
		},
		queryKey: ["home-search", debouncedQ],
		staleTime: 30_000,
	});

	// Global ⌘K / Ctrl+K — open palette anywhere.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
				e.preventDefault();
				open();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	useEffect(() => {
		if (!opened) {
			setQ("");
			setActiveIndex(0);
		}
	}, [opened]);

	const hits = useMemo<Hit[]>(() => {
		const query = q.trim().toLowerCase();
		const orgs = new Map<string, { name: string }>();
		for (const ws of workspaces) {
			if (ws.org_id && !orgs.has(ws.org_id)) {
				orgs.set(ws.org_id, { name: ws.org_name || "" });
			}
		}

		const all: Hit[] = [];
		for (const [id, o] of orgs) {
			all.push({
				href: `/o/${id}/overview`,
				icon: Buildings,
				id: `org-${id}`,
				label: o.name,
				subtitle: "Organisation",
			});
		}
		for (const ws of workspaces) {
			all.push({
				href: `/w/${ws.id}/home`,
				icon: FolderOpen,
				id: `ws-${ws.id}`,
				label: ws.name,
				subtitle: `${ws.org_name} · Workspace`,
			});
		}
		// Settings as quick shortcuts
		const settings = [
			{ href: "/settings/account", label: "Account & security" },
			{ href: "/settings/access", label: "My access" },
			{ href: "/settings/appearance", label: "Appearance" },
		];
		for (const s of settings) {
			all.push({
				href: s.href,
				icon: Gear,
				id: `setting-${s.href}`,
				label: s.label,
				subtitle: "Settings",
			});
		}

		if (!query) {
			// No query → show recents (translated to Hits) then everything
			const recentHits: Hit[] = recents.map((r) => ({
				href: r.href,
				icon: r.kind === "project" ? FolderOpen : FolderOpen,
				id: `recent-${r.kind}-${r.id}`,
				label: r.label,
				subtitle: r.parent ?? (r.kind === "project" ? "Project" : "Workspace"),
			}));
			const seen = new Set(recentHits.map((h) => h.label.toLowerCase()));
			const rest = all.filter((h) => !seen.has(h.label.toLowerCase()));
			return [...recentHits, ...rest].slice(0, 40);
		}

		const clientHits = all.filter((h) => {
			const hay = `${h.label} ${h.subtitle ?? ""}`.toLowerCase();
			return hay.includes(query);
		});

		// Deep results from /home/search, deduped by destination so the
		// same page never shows twice (e.g. a recents row + a project hit,
		// or a conversation hit + its own transcript hit).
		const merged: Hit[] = [...clientHits];
		const seenHrefs = new Set(clientHits.map((h) => h.href));
		const push = (hit: Hit) => {
			if (seenHrefs.has(hit.href)) return;
			seenHrefs.add(hit.href);
			merged.push(hit);
		};

		const deep = deepSearch.data ?? EMPTY_SEARCH;
		for (const p of deep.projects) {
			if (!p.workspaceId) continue;
			push({
				href: `/w/${p.workspaceId}/projects/${p.id}/home`,
				icon: FolderOpen,
				id: `proj-${p.id}`,
				label: p.name ?? "Project",
				subtitle: "Project",
			});
		}
		for (const c of deep.conversations) {
			if (!c.workspaceId || !c.projectId) continue;
			push({
				href: `/w/${c.workspaceId}/projects/${c.projectId}/conversation/${c.id}`,
				icon: ChatCircle,
				id: `conv-${c.id}`,
				label: c.displayLabel,
				subtitle: c.projectName
					? `${c.projectName} · Conversation`
					: "Conversation",
			});
		}
		for (const t of deep.transcripts) {
			if (!t.workspaceId || !t.projectId || !t.conversationId) continue;
			push({
				href: `/w/${t.workspaceId}/projects/${t.projectId}/conversation/${t.conversationId}`,
				icon: FileText,
				id: `chunk-${t.id}`,
				label: t.conversationLabel ?? "Transcript",
				subtitle: t.excerpt ? t.excerpt.slice(0, 80) : "Transcript",
			});
		}
		for (const ch of deep.chats) {
			if (!ch.workspaceId || !ch.projectId) continue;
			push({
				href: `/w/${ch.workspaceId}/projects/${ch.projectId}/chats/${ch.id}`,
				icon: ChatsCircle,
				id: `chat-${ch.id}`,
				label: ch.name ?? "Chat",
				subtitle: ch.projectName ? `${ch.projectName} · Chat` : "Chat",
			});
		}

		return merged.slice(0, 40);
	}, [q, workspaces, recents, deepSearch.data]);

	const onSelect = (hit: Hit) => {
		close();
		navigate(hit.href);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIndex((i) => Math.min(i + 1, hits.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIndex((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const hit = hits[activeIndex];
			if (hit) onSelect(hit);
		}
	};

	return (
		<>
			<UnstyledButton
				onClick={open}
				className="flex h-[30px] items-center gap-2 rounded-md px-2 text-[13px] transition-colors hover:bg-black/[0.04]"
				style={{ color: "#2d2d2c", width: "100%" }}
				aria-label="Search"
			>
				<MagnifyingGlass size={16} />
				<span>
					<Trans>Search</Trans>
				</span>
					<span
						className="ml-auto rounded px-1.5 py-0.5 text-[10px]"
						style={{
							backgroundColor: "rgba(45, 45, 44, 0.06)",
							color: "rgba(45, 45, 44, 0.55)",
						}}
					>
						{shortcut}
					</span>
			</UnstyledButton>

			<Modal
				opened={opened}
				onClose={close}
				size="lg"
				withCloseButton={false}
				padding={0}
				centered
				styles={{ body: { padding: 0 } }}
			>
				<div className="flex flex-col">
					<div
						className="border-b p-2"
						style={{ borderColor: "rgba(45, 45, 44, 0.08)" }}
					>
						<TextInput
							autoFocus
							value={q}
							onChange={(e) => {
								setQ(e.currentTarget.value);
								setActiveIndex(0);
							}}
							onKeyDown={onKeyDown}
							leftSection={<MagnifyingGlass size={16} />}
							placeholder="Search projects, conversations, transcripts…"
							variant="unstyled"
							styles={{ input: { fontSize: 14 } }}
						/>
					</div>
					<div className="max-h-[400px] overflow-auto p-1">
						{hits.length === 0 ? (
							<div
								className="px-3 py-6 text-center text-[12px]"
								style={{ color: "rgba(45, 45, 44, 0.55)" }}
							>
								{deepSearch.isFetching ? (
									<Trans>Searching…</Trans>
								) : (
									<Trans>No matches</Trans>
								)}
							</div>
						) : (
							hits.map((hit, i) => {
								const Icon = hit.icon;
								const active = i === activeIndex;
								return (
									<button
										type="button"
										key={hit.id}
										onClick={() => onSelect(hit)}
										onMouseEnter={() => setActiveIndex(i)}
										className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13px]"
										style={{
											backgroundColor: active
												? "rgba(65, 105, 225, 0.08)"
												: "transparent",
											color: active ? "#4169e1" : "#2d2d2c",
										}}
									>
										<Icon size={16} />
										<span className="flex-1 truncate">{hit.label}</span>
										{hit.subtitle && (
											<span
												className="truncate text-[11px]"
												style={{ color: "rgba(45, 45, 44, 0.5)" }}
											>
												{hit.subtitle}
											</span>
										)}
									</button>
								);
							})
						)}
					</div>
				</div>
			</Modal>
		</>
	);
};
