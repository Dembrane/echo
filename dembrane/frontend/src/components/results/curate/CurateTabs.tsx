import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRef } from "react";
import type { PresentationBlock } from "@/components/present/blocks";
import classes from "./curate.module.css";

/** What each tab is called, in the room's own words. */
export const tabWords = (block: PresentationBlock): string => {
	switch (block) {
		case "popcorn":
			return t`Popcorn`;
		case "tensions":
			return t`Tensions`;
		case "stakeholders":
			return t`Stakeholders`;
		default:
			// The block is still `map` on the wire; the room calls them arguments,
			// and so does everything a host reads.
			return t`Arguments`;
	}
};

export const tabId = (block: PresentationBlock) => `curate-tab-${block}`;
export const panelId = (block: PresentationBlock) => `curate-panel-${block}`;

/**
 * The same four tabs the room has.
 *
 * The audience preview above this panel has them, the presentation editor has
 * the same four as switches, and this is the third face of one thing: the
 * order is the presentation's own, the counts are the server's, and a tab
 * whose block is off is still a tab, because a host deciding whether to turn
 * it on wants to see what is in it first.
 */
export function CurateTabs({
	blocks,
	counts,
	off,
	selected,
	onSelect,
}: {
	blocks: PresentationBlock[];
	counts: Record<PresentationBlock, number>;
	off: PresentationBlock[];
	selected: PresentationBlock;
	onSelect: (block: PresentationBlock) => void;
}) {
	const list = useRef<HTMLDivElement>(null);

	// Left and right walk the tabs, Home and End reach the ends: what a tablist
	// is for, and the reason this is not four buttons in a row.
	const onKeyDown = (event: React.KeyboardEvent) => {
		const at = blocks.indexOf(selected);
		const step =
			event.key === "ArrowRight"
				? 1
				: event.key === "ArrowLeft"
					? -1
					: event.key === "Home"
						? -at
						: event.key === "End"
							? blocks.length - 1 - at
							: null;
		if (step === null) return;
		event.preventDefault();
		const next = blocks[(at + step + blocks.length) % blocks.length];
		onSelect(next);
		window.setTimeout(
			() =>
				list.current?.querySelector<HTMLElement>(`#${tabId(next)}`)?.focus(),
			0,
		);
	};

	return (
		<div
			ref={list}
			aria-label={t`Kinds of finding`}
			className={classes.tabs}
			data-testid="curate-tabs"
			onKeyDown={onKeyDown}
			role="tablist"
		>
			{blocks.map((block) => {
				const on = block === selected;
				return (
					<button
						key={block}
						type="button"
						aria-controls={panelId(block)}
						aria-selected={on}
						className={classes.tab}
						data-testid={`curate-tab-${block}`}
						id={tabId(block)}
						onClick={() => onSelect(block)}
						role="tab"
						tabIndex={on ? 0 : -1}
					>
						<span>{tabWords(block)}</span>
						<span className={classes.tabCount}>{counts[block] ?? 0}</span>
						{/* A block that is off in this presentation says so in the row,
						    in the word itself rather than a colour or a glyph. */}
						{off.includes(block) && (
							<span className={classes.tabOff}>
								<Trans>off</Trans>
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
