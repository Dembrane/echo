import { Badge, Button, Group, Text, Tooltip } from "@mantine/core";
import { diffLines, diffSentences, diffWords } from "diff";
import type React from "react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

export type DiffViewerProps = {
	leftText: string;
	rightText: string;
	leftTitle?: string;
	rightTitle?: string;
	note?: string;
	/** If provided, note becomes editable. */
	onNoteChange?: (value: string) => void;
	/** Start in compact mode (collapses large unchanged blocks). */
	compact?: boolean;
	/** Threshold for collapsing unchanged blocks in compact mode. Default 8. */
	collapseThreshold?: number;
	/** Number of context lines to show around collapsed blocks. Default 2. */
	contextLines?: number;
	/** Component width. Default '100%'. */
	width?: number | string;
	/** Component height. Default '70vh' to fit typical modals. */
	height?: number | string;
	/** Optional className passthrough. */
	className?: string;
	/** Optional sticky area rendered above diff rows inside the scroll container. */
	topStickyContent?: ReactNode;
};

// Row rendering type
type RowKind = "unchanged" | "added" | "removed" | "modified";

interface Row {
	left: string | null;
	right: string | null;
	kind: RowKind;
}

type SplitMode = "line" | "sentence";

const normalizeNewlines = (s: string) => (s ?? "").replace(/\r\n/g, "\n");

const sentenceRegex = /[^.!?\n]+[.!?]?(?:\s+|$)/g;

const splitValue = (s: string, mode: SplitMode) => {
	const normalized = normalizeNewlines(s);
	if (mode === "line") return normalized.split("\n");
	const matches = normalized.match(sentenceRegex);
	if (!matches) return normalized ? [normalized] : [];
	return matches.map((part) => part.trim()).filter((part) => part.length > 0);
};

// Build aligned side-by-side rows from diff blocks
function buildRows(leftText: string, rightText: string): Row[] {
	const left = normalizeNewlines(leftText ?? "");
	const right = normalizeNewlines(rightText ?? "");
	const useSentenceDiff = !/\n/.test(left) && !/\n/.test(right);
	const mode: SplitMode = useSentenceDiff ? "sentence" : "line";

	const parts = useSentenceDiff
		? diffSentences(left, right)
		: diffLines(left, right, { newlineIsToken: true });
	const rows: Row[] = [];

	let i = 0;
	while (i < parts.length) {
		const cur = parts[i] as any;

		if (cur.added) {
			const prev = parts[i - 1] as any | undefined;
			// Pair added with a preceding removed when present
			if (prev?.removed) {
				const L = splitValue(prev.value, mode);
				const R = splitValue(cur.value, mode);
				const max = Math.max(L.length, R.length);
				for (let k = 0; k < max; k++) {
					const l = k < L.length ? L[k] : null;
					const r = k < R.length ? R[k] : null;
					if (l !== null && r !== null) {
						rows.push({
							kind: l === r ? "unchanged" : "modified",
							left: l,
							right: r,
						});
					} else if (l !== null) {
						rows.push({ kind: "removed", left: l, right: null });
					} else {
						rows.push({ kind: "added", left: null, right: r });
					}
				}
			} else {
				const R = splitValue(cur.value, mode);
				for (const r of R) rows.push({ kind: "added", left: null, right: r });
			}
			i++;
			continue;
		}

		if ((cur as any).removed) {
			// Only push standalone removals. Paired removals are handled when their matching add appears.
			const next = parts[i + 1] as any | undefined;
			if (!(next && next.added)) {
				const L = splitValue(cur.value, mode);
				for (const l of L) rows.push({ kind: "removed", left: l, right: null });
			}
			i++;
			continue;
		}

		// Unchanged block
		const U = splitValue((cur as any).value, mode);
		for (const u of U) rows.push({ kind: "unchanged", left: u, right: u });
		i++;
	}

	return rows;
}

// Inline word-level highlighting for modified lines.
function WordDiff({
	left,
	right,
	side,
}: {
	left: string | null;
	right: string | null;
	side: "left" | "right";
}) {
	if (left === null || right === null)
		return <span>{left ?? right ?? ""}</span>;
	const chunks = diffWords(left, right);
	if (side === "left") {
		return (
			<span>
				{/** biome-ignore lint/suspicious/noExplicitAny: needs to be fixed */}
				{chunks.map((p: any, i: number) => {
					if (p.added) return null; // hide additions on left
					const cls = p.removed ? "bg-red-200/70" : undefined;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: needs to be fixed
						<span key={i} className={cls}>
							{p.value}
						</span>
					);
				})}
			</span>
		);
	}
	return (
		<span>
			{/** biome-ignore lint/suspicious/noExplicitAny: needs to be fixed */}
			{chunks.map((p: any, i: number) => {
				if (p.removed) return null; // hide removals on right
				const cls = p.added ? "bg-green-200/70" : undefined;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: needs to be fixed
					<span key={i} className={cls}>
						{p.value}
					</span>
				);
			})}
		</span>
	);
}

function cn(...classes: Array<string | false | undefined | null>) {
	return classes.filter(Boolean).join(" ");
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
	leftText,
	rightText,
	leftTitle = "Original",
	rightTitle = "Revised",
	note,
	onNoteChange,
	compact = false,
	collapseThreshold = 8,
	contextLines = 2,
	width = "100%",
	height = "100%",
	className,
	topStickyContent,
}) => {
	const [isCompact, _setIsCompact] = useState<boolean>(compact);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	// Reset expansions when inputs change or when compact mode toggles back on
	useEffect(() => setExpanded({}), []);
	useEffect(() => {
		if (isCompact) setExpanded({});
	}, [isCompact]);

	const rows = useMemo(
		() => buildRows(leftText, rightText),
		[leftText, rightText],
	);

	const stats = useMemo(() => {
		let added = 0;
		let removed = 0;
		let modified = 0;
		let unchanged = 0;

		for (const row of rows) {
			switch (row.kind) {
				case "added":
					added++;
					break;
				case "removed":
					removed++;
					break;
				case "modified":
					modified++;
					break;
				default:
					unchanged++;
			}
		}

		return {
			added,
			delta: added - removed,
			modified,
			removed,
			total: rows.length,
			unchanged,
		};
	}, [rows]);

	// Compute unchanged ranges for compact mode
	const plan = useMemo(() => {
		if (!isCompact)
			return rows.length
				? [{ from: 0, to: rows.length - 1, type: "show" }]
				: [];

		const ranges: Array<{ start: number; end: number }> = [];
		let s = -1;
		for (let i = 0; i < rows.length; i++) {
			if (rows[i].kind === "unchanged") {
				if (s === -1) s = i;
			} else if (s !== -1) {
				const e = i - 1;
				if (e - s + 1 >= collapseThreshold) ranges.push({ end: e, start: s });
				s = -1;
			}
		}
		if (s !== -1) {
			const e = rows.length - 1;
			if (e - s + 1 >= collapseThreshold) ranges.push({ end: e, start: s });
		}

		const out: Array<
			| { type: "show"; from: number; to: number }
			| { type: "gap"; at: number; count: number; key: string }
		> = [];
		let idx = 0;
		for (const r of ranges) {
			if (idx < r.start) out.push({ from: idx, to: r.start - 1, type: "show" });
			const key = `${r.start}-${r.end}`;
			out.push({ at: r.start, count: r.end - r.start + 1, key, type: "gap" });
			idx = r.end + 1;
		}
		if (idx < rows.length)
			out.push({ from: idx, to: rows.length - 1, type: "show" });
		return out;
	}, [rows, isCompact, collapseThreshold]);

	// Line numbers for each visible row
	const lineNumbers = useMemo(() => {
		const nums: Array<{ l?: number; r?: number }> = [];
		let l = 1;
		let r = 1;
		for (const row of rows) {
			const obj: { l?: number; r?: number } = {};
			if (row.left !== null) obj.l = l++;
			if (row.right !== null) obj.r = r++;
			nums.push(obj);
		}
		return nums;
	}, [rows]);

	// biome-ignore lint/correctness/noNestedComponentDefinitions: needs to be fixed
	const RowView: React.FC<{ row: Row; index: number }> = ({ row, index }) => {
		const leftCls =
			row.kind === "removed"
				? "bg-red-50/80 border-l-4 border-red-400"
				: row.kind === "modified"
					? "bg-yellow-50/60 border-l-4 border-yellow-400"
					: undefined;

		const rightCls =
			row.kind === "added"
				? "bg-green-50/80 border-l-4 border-green-400"
				: row.kind === "modified"
					? "bg-yellow-50/60 border-l-4 border-yellow-400"
					: undefined;

		return (
			<div className="grid grid-cols-[56px_1fr_56px_1fr] gap-0 text-xs font-mono whitespace-pre-wrap">
				{/* Left line */}
				<div
					className={cn(
						"px-2 py-1 text-right text-slate-400 select-none border-b border-slate-100",
						row.left === null && "bg-slate-50/50",
					)}
				>
					{lineNumbers[index].l ?? ""}
				</div>
				<div className={cn("px-3 py-1 border-b border-slate-100", leftCls)}>
					{row.kind === "modified" ? (
						<WordDiff left={row.left} right={row.right} side="left" />
					) : (
						row.left
					)}
				</div>
				{/* Right line */}
				<div
					className={cn(
						"px-2 py-1 text-right text-slate-400 select-none border-b border-slate-100",
						row.right === null && "bg-slate-50/50",
					)}
				>
					{lineNumbers[index].r ?? ""}
				</div>
				<div className={cn("px-3 py-1 border-b border-slate-100", rightCls)}>
					{row.kind === "modified" ? (
						<WordDiff left={row.left} right={row.right} side="right" />
					) : (
						row.right
					)}
				</div>
			</div>
		);
	};

	const renderRows = () => {
		const out: Array<ReactNode> = [];
		if (!plan.length) return out;

		// biome-ignore lint/suspicious/noExplicitAny: needs to be fixed
		for (const step of plan as any[]) {
			if (step.type === "show") {
				for (let i = step.from; i <= step.to; i++)
					out.push(<RowView key={i} row={rows[i]} index={i} />);
			} else {
				const { at, count, key } = step;
				const isOpen = expanded[key];
				if (!isOpen) {
					// top context
					for (let i = at; i < Math.min(at + contextLines, at + count); i++)
						out.push(<RowView key={i} row={rows[i]} index={i} />);
					out.push(
						<div
							key={`gap-${key}`}
							className="grid grid-cols-[56px_1fr_56px_1fr]"
						>
							<div className="col-span-4">
								<div className="flex items-center justify-center gap-2 py-1.5 bg-slate-50 text-slate-600 border-y border-slate-100">
									<Badge variant="light" color="gray" radius="sm">
										{count} unchanged lines
									</Badge>
									<Button
										size="xs"
										variant="default"
										onClick={() => setExpanded((s) => ({ ...s, [key]: true }))}
									>
										Expand
									</Button>
								</div>
							</div>
						</div>,
					);
					// bottom context
					for (
						let i = Math.max(at, at + count - contextLines);
						i < at + count;
						i++
					)
						out.push(<RowView key={i} row={rows[i]} index={i} />);
				} else {
					for (let i = at; i < at + count; i++)
						out.push(<RowView key={i} row={rows[i]} index={i} />);
					out.push(
						<div
							key={`collapse-${key}`}
							className="grid grid-cols-[56px_1fr_56px_1fr]"
						>
							<div className="col-span-4">
								<div className="flex items-center justify-center gap-2 py-1.5 bg-slate-50 text-slate-600 border-b border-slate-100">
									<Button
										size="xs"
										variant="default"
										onClick={() => setExpanded((s) => ({ ...s, [key]: false }))}
									>
										Collapse
									</Button>
								</div>
							</div>
						</div>,
					);
				}
			}
		}
		return out;
	};

	return (
		<div
			className={cn("flex flex-col gap-3 min-h-0  w-full", className)}
			style={{ height, width }}
		>
			{/* Note */}
			{onNoteChange ? (
				<textarea
					className="w-full resize-none rounded-md border border-slate-200 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
					rows={3}
					placeholder="Add a note for this diff..."
					value={note ?? ""}
					onChange={(e) => onNoteChange(e.currentTarget.value)}
				/>
			) : note ? (
				<Text size="sm" className="text-slate-700">
					{note}
				</Text>
			) : null}

			{topStickyContent ? (
				<div className="border-slate-100">{topStickyContent}</div>
			) : null}

			{/* Controls */}
			<Group justify="space-between" gap="xs" align="flex-start">
				<div className="flex items-center gap-3">
					{/* <Tooltip label="Collapse long unchanged regions">
            <Switch size="sm" checked={isCompact} onChange={(e) => setIsCompact(e.currentTarget.checked)} label="Compact view" />
          </Tooltip> */}
					<Badge color="gray" variant="light" radius="sm">
						{rows.length} lines
					</Badge>
				</div>
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<Badge color="green" variant="light" radius="sm">
						+{stats.added} added
					</Badge>
					<Badge color="red" variant="light" radius="sm">
						-{stats.removed} removed
					</Badge>
					<Badge color="yellow" variant="light" radius="sm">
						{stats.modified} modified
					</Badge>
					<Badge color="gray" variant="outline" radius="sm">
						{stats.unchanged} unchanged
					</Badge>
					<Tooltip label="Net line change (added - removed)">
						<Badge
							color={stats.delta >= 0 ? "green" : "red"}
							variant="filled"
							radius="sm"
						>
							{stats.delta >= 0 ? `+${stats.delta}` : stats.delta} net
						</Badge>
					</Tooltip>
				</div>
			</Group>

			<div className="flex-1 min-h-0 w-full border border-slate-100 rounded-lg overflow-y-auto">
				<div className="sticky top-0 z-20 rounded-t-lg" style={{ backgroundColor: "var(--app-background)" }}>
					<div className="grid grid-cols-2 gap-0 text-sm text-slate-600">
						<div className="px-3 py-1.5 bg-slate-50 border-b border-slate-100 rounded-tl-lg">
							{leftTitle}
						</div>
						<div className="px-3 py-1.5 bg-slate-50 border-b border-slate-100 rounded-tr-lg">
							{rightTitle}
						</div>
					</div>
				</div>
				{renderRows()}
			</div>
		</div>
	);
};

export default DiffViewer;
