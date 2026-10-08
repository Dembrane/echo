import { plural, t } from "@lingui/core/macro";
import { Anchor } from "@mantine/core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "@/components/common/Toaster";
import {
	isAttemptRunning,
	useMapEvents,
	useProjectMapSummary,
} from "@/components/map/hooks";
import { presentationKey, usePresentation } from "@/components/present/hooks";
import { useAllProjectReports } from "@/components/report/hooks";
import { API_BASE_URL, ENABLE_PRESENT } from "@/config";
import { useConversationMonitor } from "@/hooks/useConversationMonitor";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useServerEvents } from "@/hooks/useServerEvents";
import { getAgenticRun } from "@/lib/api";
import { useIsMobile } from "../sidebar/hooks/useIsMobile";
import { finishedTitle, openLabel } from "./copy";
import {
	chitKey,
	getProcessState,
	type ProcessMeta,
	setActiveTool,
	setPopout,
	type Tool,
	trackProcess,
	useProcessState,
} from "./store";

// How long a phone's rail item holds its name out after a process finishes.
const POPOUT_MS = 4000;
const ASK_POLL_MS = 4000;

const SECTION_TOOL: Record<string, Tool> = {
	chats: "ask",
	conversations: "conversations",
	map: "map",
	present: "present",
	report: "report",
};

type WatcherProps = { projectId: string; base: string; onPage: boolean };

const MapWatcher = ({ projectId, base, onPage }: WatcherProps) => {
	const summary = useProjectMapSummary(projectId);
	// The map page follows the stream itself and keeps the cache fresh; a
	// second stream from here would only double the connection.
	useMapEvents(onPage ? "" : projectId);
	const data = summary.data;
	useEffect(() => {
		if (!data) return;
		const meta: ProcessMeta = { href: `${base}/map`, projectId, tool: "map" };
		const attempt = data.attempt;
		const progress = attempt?.progress;
		const total = progress?.conversations_total ?? 0;
		const done = progress?.conversations_done ?? 0;
		trackProcess(
			`map:${projectId}`,
			meta,
			isAttemptRunning(attempt)
				? total
					? {
							detail: plural(total, {
								one: `${done} of # conversation`,
								other: `${done} of # conversations`,
							}),
							done,
							total,
						}
					: {}
				: null,
			attempt?.status === "failed" ? (attempt.error ?? "") : undefined,
		);
	}, [data, base, projectId]);
	return null;
};

const PresentWatcher = ({ projectId, base, onPage }: WatcherProps) => {
	const client = useQueryClient();
	const query = usePresentation(projectId);
	const presentation = query.data?.presentation ?? null;
	useServerEvents(
		presentation && !onPage
			? `${API_BASE_URL}/v2/bff/popcorn/${encodeURIComponent(presentation.id)}/events`
			: null,
		["update"],
		() => client.invalidateQueries({ queryKey: presentationKey(projectId) }),
	);
	useEffect(() => {
		if (!query.data) return;
		const meta: ProcessMeta = {
			href: `${base}/present`,
			projectId,
			tool: "present",
		};
		const counts = presentation?.counts;
		const loop = presentation?.loop;
		const reading = counts?.reading ?? 0;
		trackProcess(
			`present:read:${projectId}`,
			// A live loop reads every few minutes: show it working, never
			// announce each read.
			{ ...meta, quiet: loop?.mode === "live" },
			counts && reading > 0
				? {
						detail: plural(counts.conversations, {
							one: `Reading ${reading} of # conversation…`,
							other: `Reading ${reading} of # conversations…`,
						}),
						done: counts.conversations_read,
						total: counts.conversations,
					}
				: null,
			loop?.last_run_status === "error"
				? (loop.last_run_detail ?? "")
				: undefined,
		);
		const translation = presentation?.translation_status;
		trackProcess(
			`present:translate:${projectId}`,
			meta,
			translation?.state === "translating"
				? {
						detail: t`${translation.translated} of ${translation.total} texts translated`,
						done: translation.translated,
						total: translation.total,
					}
				: null,
			translation?.state === "incomplete"
				? (translation.detail ?? "")
				: undefined,
		);
	}, [query.data, presentation, base, projectId]);
	return null;
};

const ConversationsWatcher = ({ projectId, base }: WatcherProps) => {
	const { summary, conversations } = useConversationMonitor(projectId);
	const errorsAtStart = useRef<number | null>(null);
	useEffect(() => {
		const meta: ProcessMeta = {
			href: `${base}/conversations`,
			projectId,
			tool: "conversations",
		};
		// Recording and transcribing are one piece of work: while anyone is
		// still recording, the backlog empties and fills again with every chunk.
		const running = summary.live > 0 || summary.pending_transcription > 0;
		if (running && errorsAtStart.current === null)
			errorsAtStart.current = summary.with_errors;
		const newErrors =
			summary.with_errors - (errorsAtStart.current ?? summary.with_errors);
		const pending = conversations.filter((c) => c.pending_transcription > 0);
		const total = pending.reduce((sum, c) => sum + c.chunk_count, 0);
		const done = pending.reduce((sum, c) => sum + c.transcribed_count, 0);
		trackProcess(
			`conversations:${projectId}`,
			meta,
			!running
				? null
				: summary.live > 0
					? {
							detail: plural(summary.live, {
								one: "# conversation recording",
								other: "# conversations recording",
							}),
						}
					: {
							detail: plural(summary.pending_transcription, {
								one: "# part to transcribe",
								other: "# parts to transcribe",
							}),
							done,
							total,
						},
			!running && newErrors > 0
				? plural(newErrors, {
						one: "# conversation could not be transcribed.",
						other: "# conversations could not be transcribed.",
					})
				: undefined,
		);
		if (!running) errorsAtStart.current = null;
	}, [summary, conversations, base, projectId]);
	return null;
};

const ReportWatcher = ({ projectId, base }: WatcherProps) => {
	const reports = useAllProjectReports(projectId);
	useEffect(() => {
		const meta: ProcessMeta = {
			href: `${base}/report`,
			projectId,
			tool: "report",
		};
		// A draft is a report being written.
		for (const report of reports.data ?? [])
			trackProcess(
				`report:${report.id}`,
				meta,
				report.status === "draft" ? {} : null,
				report.status === "error" || report.status === "cancelled"
					? ""
					: undefined,
			);
	}, [reports.data, base, projectId]);
	return null;
};

/** Follows the processes of the project on screen and tells the store which
 * tool is open. Mounted once, beside the sidebar. */
export const ProjectProcessWatchers = ({
	workspaceId,
	projectId,
	section,
}: {
	workspaceId: string;
	projectId: string;
	section?: string;
}) => {
	const tool = (section && SECTION_TOOL[section]) || null;
	useEffect(() => {
		setActiveTool(projectId, tool);
	}, [projectId, tool]);
	useEffect(() => () => setActiveTool(null, null), []);

	const base = `/w/${workspaceId}/projects/${projectId}`;
	const props = (own: Tool) => ({ base, onPage: tool === own, projectId });
	return (
		<>
			<MapWatcher {...props("map")} />
			{ENABLE_PRESENT && <PresentWatcher {...props("present")} />}
			<ConversationsWatcher {...props("conversations")} />
			<ReportWatcher {...props("report")} />
		</>
	);
};

/** Ask plans run on after you leave their chat; this follows each one the
 * chat reported running until it ends, wherever you are. */
export const AskWatcher = () => {
	const { processes } = useProcessState();
	const asks = Object.entries(processes).filter(
		([, process]) => process.tool === "ask",
	);
	const runs = useQueries({
		queries: asks.map(([key]) => {
			const runId = key.slice("ask:".length);
			return {
				queryFn: () => getAgenticRun(runId),
				queryKey: ["processes", "agentic-run", runId],
				refetchInterval: ASK_POLL_MS,
			};
		}),
	});
	useEffect(() => {
		runs.forEach((run, index) => {
			const entry = asks[index];
			const status = run.data?.status;
			if (!entry || !status || status === "queued" || status === "running")
				return;
			const [key, process] = entry;
			trackProcess(
				key,
				process,
				null,
				status === "completed" ? undefined : (run.data?.latest_error ?? ""),
			);
		});
	});
	return null;
};

/** Says that a process finished: a toast on a desktop, the rail item's name
 * popping out on a phone. */
export const ProcessNotices = () => {
	const { notices } = useProcessState();
	const isMobile = useIsMobile();
	const navigate = useI18nNavigate();
	// Notices already said; the first render only takes note of old ones.
	const shown = useRef<number | null>(null);

	useEffect(() => {
		const last = notices.at(-1)?.id ?? 0;
		if (shown.current === null) {
			shown.current = last;
			return;
		}
		const fresh = notices.filter((n) => n.id > (shown.current ?? 0));
		shown.current = last;
		for (const { failed, message, tool, href, projectId } of fresh) {
			if (isMobile) {
				const key = chitKey(projectId, tool);
				setPopout(key);
				setTimeout(() => {
					if (getProcessState().popout === key) setPopout(null);
				}, POPOUT_MS);
				continue;
			}
			const show = failed ? toast.error : toast.success;
			show(finishedTitle(tool, failed), {
				description: (
					<>
						{message ? <span className="block">{message}</span> : null}
						<Anchor
							component="button"
							type="button"
							size="sm"
							onClick={() => navigate(href)}
						>
							{openLabel(tool)}
						</Anchor>
					</>
				),
			});
		}
	}, [notices, isMobile, navigate]);
	return null;
};
