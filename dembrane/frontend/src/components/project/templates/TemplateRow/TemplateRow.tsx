import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Button, Group, Skeleton, Text } from "@mantine/core";
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
	type CardKey,
	rowCards,
	type TemplateSummary,
} from "../projectTemplates";
import { TemplateCardButton } from "../TemplateCard/TemplateCardButton";
import type { TemplateChoiceContext } from "../TemplatePicker/TemplatePicker";
import classes from "./TemplateRow.module.css";

interface TemplateRowProps {
	/** From GET /v2/project-templates; undefined while it loads. */
	templates: readonly TemplateSummary[] | undefined;
	/** The list could not load: no row, only the way to all formats (and blank). */
	failed?: boolean;
	/** A card was pressed: the flow moves on with it. */
	onChoose: (key: CardKey, context: TemplateChoiceContext) => void;
	/** "See all formats": skip the row for the full list with its filters. */
	onSeeAll: () => void;
}

const reducedMotion = () =>
	Boolean(
		globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
	);

/**
 * "Or start from a format" (ECHO-1058): every template in one horizontal row, the most used
 * first. Pressing a card chooses it and moves on. One tab stop; the arrow keys, Home and
 * End move between cards and bring them into view. Props in, callbacks out.
 */
export const TemplateRow = ({
	templates,
	failed = false,
	onChoose,
	onSeeAll,
}: TemplateRowProps) => {
	const headingId = useId();
	const listRef = useRef<HTMLUListElement>(null);
	const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const [focus, setFocus] = useState(0);
	const [ends, setEnds] = useState({ end: false, start: true });
	const cards = rowCards(templates ?? []) as (TemplateSummary & {
		key: CardKey;
	})[];

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
			<Group justify="space-between" align="center" mb="xs" wrap="nowrap">
				<Text component="h3" size="md" m={0} id={headingId}>
					<Trans>Or start from a format</Trans>
				</Text>
				<Group
					gap={4}
					wrap="nowrap"
					display={cards.length ? undefined : "none"}
				>
					<ActionIcon
						variant="subtle"
						color="gray"
						size="lg"
						onClick={() => page(-1)}
						disabled={ends.start}
						aria-label={t`Earlier formats`}
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
						aria-label={t`More formats`}
						data-testid="template-row-next"
					>
						<CaretRightIcon size={20} aria-hidden />
					</ActionIcon>
				</Group>
			</Group>
			{!templates || failed ? (
				failed ? null : (
					<Group
						gap="sm"
						wrap="nowrap"
						aria-busy="true"
						style={{ overflow: "hidden" }}
					>
						{[0, 1, 2].map((i) => (
							<Skeleton
								key={i}
								height={280}
								w={264}
								style={{ flexShrink: 0 }}
							/>
						))}
					</Group>
				)
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
								tabIndex={i === focus ? 0 : -1}
								onKeyDown={onKeyDown(i)}
								onChoose={() =>
									onChoose(tpl.key, {
										featured: tpl.card.featured,
										filtersActive: [],
										list: "row",
										setup: tpl.card.setup,
										verbs: tpl.card.verbs,
									})
								}
							/>
						</li>
					))}
				</ul>
			)}
			<Button
				variant="outline"
				size="sm"
				mt="md"
				onClick={onSeeAll}
				data-testid="template-row-see-all"
			>
				<Trans>See all formats</Trans>
			</Button>
		</section>
	);
};
