import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Anchor, Group, Skeleton, Text } from "@mantine/core";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	type ChoiceKey,
	cardFacts,
	rowCards,
	type TemplateChoiceContext,
	type TemplateKey,
	type TemplateSummary,
	withQuickStart,
} from "../projectTemplates";
import { TemplateCardButton } from "../TemplateCard/TemplateCardButton";
import classes from "./TemplateRow.module.css";

interface TemplateRowProps {
	/** From GET /v2/project-templates; undefined while it loads. */
	templates: readonly TemplateSummary[] | undefined;
	/** The list could not load: Quick start alone, and the way to all formats. */
	failed?: boolean;
	/**
	 * The template the project starts from now, drawn chosen and kept in view. One the bar
	 * has no card for ("Upload recordings", an old link's key) leaves no card chosen.
	 */
	selected: TemplateKey;
	/** A card was pressed: it becomes the chosen one. The page stays where it is. */
	onChoose: (key: ChoiceKey, context: TemplateChoiceContext) => void;
	/** "See all templates": the full list with its filters and what each is for. */
	onSeeAll: () => void;
}

const reducedMotion = () =>
	Boolean(
		globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
	);

/**
 * "Start from a template" (ECHO-1058), a bar above the project name on the create page:
 * Quick start first, then every template in one horizontal row of small cards, the most
 * used first. Pressing a card chooses it in place; nothing else on the page moves. One tab
 * stop; the arrow keys, Home and End move between cards and bring them into view. Props
 * in, callbacks out.
 */
export const TemplateRow = ({
	templates,
	failed = false,
	selected,
	onChoose,
	onSeeAll,
}: TemplateRowProps) => {
	const headingId = useId();
	const listRef = useRef<HTMLUListElement>(null);
	const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);
	// The tab stop: the card the arrow keys last reached, else the chosen one.
	const [focus, setFocus] = useState<number | null>(null);
	const [ends, setEnds] = useState({ end: false, start: true });
	const loading = !templates && !failed;
	const cards = withQuickStart(failed ? [] : rowCards(templates ?? []));
	const chosenAt = cards.findIndex((c) => c.key === selected);
	// The list can shrink under the focus (a refetch that fails leaves Quick start alone):
	// one card always keeps the tab stop.
	const tabStop = Math.min(focus ?? Math.max(0, chosenAt), cards.length - 1);

	const measure = useCallback(() => {
		const el = listRef.current;
		if (!el) return;
		setEnds({
			end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
			start: el.scrollLeft <= 2,
		});
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: measure again once the cards are in
	useEffect(() => {
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [measure, cards.length]);

	// A template chosen elsewhere (a link, all templates) can sit past the bar's edge: the
	// bar alone scrolls to it, never the page. A card pressed in the bar is in view already.
	// biome-ignore lint/correctness/useExhaustiveDependencies: again once the cards are in
	useEffect(() => {
		const el = listRef.current;
		const card = cardRefs.current[chosenAt];
		if (!el || !card) return;
		// The bar is the cards' offset parent (TemplateRow.module.css).
		const left = card.offsetLeft;
		const inView =
			left >= el.scrollLeft &&
			left + card.offsetWidth <= el.scrollLeft + el.clientWidth;
		if (!inView) el.scrollLeft = Math.max(0, left - 4);
		measure();
	}, [chosenAt, cards.length, measure]);

	const page = (dir: 1 | -1) => {
		const el = listRef.current;
		if (!el) return;
		el.scrollBy?.({
			behavior: reducedMotion() ? "auto" : "smooth",
			left: dir * el.clientWidth * 0.8,
		});
	};

	const moveTo = (i: number) => {
		const next = Math.max(0, Math.min(cards.length - 1, i));
		setFocus(next);
		const card = cardRefs.current[next];
		card?.focus({ preventScroll: true });
		card?.scrollIntoView?.({
			behavior: reducedMotion() ? "auto" : "smooth",
			block: "nearest",
			inline: "nearest",
		});
	};

	const onKeyDown = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
		const to =
			e.key === "ArrowRight"
				? i + 1
				: e.key === "ArrowLeft"
					? i - 1
					: e.key === "Home"
						? 0
						: e.key === "End"
							? cards.length - 1
							: null;
		if (to === null) return;
		e.preventDefault();
		moveTo(to);
	};

	return (
		<section aria-labelledby={headingId} data-testid="template-row">
			<Group
				className="app-stack-narrow"
				justify="space-between"
				align="center"
				mb="xs"
				wrap="nowrap"
			>
				<Text component="h3" size="lg" m={0} id={headingId}>
					<Trans>Start from a template</Trans>
				</Text>
				<Group gap="sm" wrap="nowrap" justify="space-between">
					{/* A quiet link, as "Upload recordings" is in all templates: no box, so it
					    lines up with the heading when the row stacks on a phone. */}
					<Anchor
						component="button"
						type="button"
						size="sm"
						onClick={onSeeAll}
						data-testid="template-row-see-all"
					>
						<Trans>See all templates</Trans>
					</Anchor>
					<Group
						gap={4}
						wrap="nowrap"
						display={!loading && cards.length > 1 ? undefined : "none"}
					>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="lg"
							onClick={() => page(-1)}
							disabled={ends.start}
							aria-label={t`Earlier templates`}
							data-testid="template-row-prev"
						>
							<CaretLeftIcon size={20} aria-hidden />
						</ActionIcon>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="lg"
							onClick={() => page(1)}
							disabled={ends.end}
							aria-label={t`More templates`}
							data-testid="template-row-next"
						>
							<CaretRightIcon size={20} aria-hidden />
						</ActionIcon>
					</Group>
				</Group>
			</Group>
			{loading ? (
				<Group
					gap="sm"
					wrap="nowrap"
					aria-busy="true"
					style={{ overflow: "hidden" }}
				>
					{[0, 1, 2, 3, 4].map((i) => (
						<Skeleton key={i} height={124} w={160} style={{ flexShrink: 0 }} />
					))}
				</Group>
			) : (
				<ul
					ref={listRef}
					className={classes.row}
					onScroll={measure}
					data-testid="template-row-list"
				>
					{cards.map((tpl, i) => (
						<li key={tpl.key} className={classes.item}>
							<TemplateCardButton
								ref={(el) => {
									cardRefs.current[i] = el;
								}}
								template={tpl}
								compact
								selected={tpl.key === selected}
								tabIndex={i === tabStop ? 0 : -1}
								onKeyDown={onKeyDown(i)}
								onChoose={() =>
									onChoose(tpl.key, {
										...cardFacts(tpl),
										filtersActive: [],
										list: "row",
									})
								}
							/>
						</li>
					))}
				</ul>
			)}
		</section>
	);
};
