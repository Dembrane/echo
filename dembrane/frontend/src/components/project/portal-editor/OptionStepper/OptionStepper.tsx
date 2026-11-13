import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Group,
	Stack,
	Text,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
} from "react";
import { FlowProgress } from "@/components/common/FlowProgress/FlowProgress";
import { ShownTitleContext } from "@/components/form/FormLabel";
import { testId } from "@/lib/testUtils";

const RULE = "var(--app-stroke) solid var(--app-rule-color)";
/** Rows stacked at gap 0 draw the line they share once (as styles/joined.css does). */
const STEP_BACK = "calc(-1 * var(--app-stroke))";

export interface StepperOption {
	key: string;
	title: string;
	/** The option's current value in one line, shown while it is closed. */
	summary: ReactNode;
	/** The option's field, shown while it is open. */
	body: ReactNode;
	/** An early feature: "Beta" beside its name. */
	beta?: boolean;
}

export type StepVia = "row" | "next" | "back";

interface OptionStepperProps {
	options: readonly StepperOption[];
	/** The open option; the first when it names none of them. */
	openKey: string | null;
	onOpen: (key: string, via: StepVia) => void;
	/** After the last option: where "Next" goes (the next page), if anywhere. */
	nextLabel?: string;
	onNextPage?: () => void;
	testIdPrefix?: string;
}

/**
 * A page of options, one open at a time (ECHO-1060): calm rows, each closed one saying its
 * current value in a line, the open one showing its field with Back and Next under it, and
 * a thin progress line, as in the create flow. Clicking a row opens it; the arrow keys move
 * between rows, Home and End jump, Enter or Space opens, and opening moves focus to the
 * row. The open option's title names its field: a field label with the same words is not
 * shown again under it (FormLabel reads ShownTitleContext), but is still read out. Props
 * in, callbacks out.
 *
 * A closed row is a box you press: its name in the first half, its value in the second
 * (cut to one line, never over the name). The open option is one unfolded box (ECHO-1062):
 * its name across the whole row, then its field and its buttons, with no line between.
 */
export const OptionStepper = ({
	options,
	openKey,
	onOpen,
	nextLabel,
	onNextPage,
	testIdPrefix = "portal-option",
}: OptionStepperProps) => {
	const baseId = useId();
	const headers = useRef<(HTMLButtonElement | null)[]>([]);
	const index = Math.max(
		0,
		options.findIndex((o) => o.key === openKey),
	);
	const open = options[index];
	const lastFocused = useRef<string | null>(null);

	// Moving to another option moves focus to its row, so the keyboard stays with the
	// open option. Not on first render: the page opens without stealing focus.
	useEffect(() => {
		if (!open) return;
		if (lastFocused.current === null) {
			lastFocused.current = open.key;
			return;
		}
		if (lastFocused.current === open.key) return;
		lastFocused.current = open.key;
		headers.current[index]?.focus({ preventScroll: false });
	}, [open, index]);

	const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
		const go = (to: number) => {
			e.preventDefault();
			headers.current[Math.max(0, Math.min(options.length - 1, to))]?.focus();
		};
		if (e.key === "ArrowDown") go(i + 1);
		else if (e.key === "ArrowUp") go(i - 1);
		else if (e.key === "Home") go(0);
		else if (e.key === "End") go(options.length - 1);
	};

	if (!open) return null;
	const isLast = index === options.length - 1;

	return (
		<Stack gap="md" {...testId(`${testIdPrefix}-stepper`)}>
			<FlowProgress
				step={index + 1}
				total={options.length}
				testId={`${testIdPrefix}-progress`}
			/>
			<Stack gap={0} component="ul" m={0} p={0} style={{ listStyle: "none" }}>
				{options.map((option, i) => {
					const isOpen = i === index;
					const headerId = `${baseId}-${option.key}-header`;
					const bodyId = `${baseId}-${option.key}-body`;
					const Caret = isOpen ? CaretDownIcon : CaretRightIcon;
					return (
						<li
							key={option.key}
							style={{
								border: isOpen ? RULE : undefined,
								marginTop: i > 0 ? STEP_BACK : undefined,
							}}
							data-open={isOpen || undefined}
							{...testId(`${testIdPrefix}-${option.key}`)}
						>
							<Title order={5} m={0}>
								<UnstyledButton
									ref={(el) => {
										headers.current[i] = el;
									}}
									id={headerId}
									aria-expanded={isOpen}
									aria-controls={bodyId}
									onClick={() => {
										if (!isOpen) onOpen(option.key, "row");
									}}
									onKeyDown={(e) => onRowKey(e, i)}
									// Closed, the row is the box; open, the item around it is.
									className={isOpen ? "block w-full" : "app-do block w-full"}
									px="sm"
									py="sm"
									style={isOpen ? { cursor: "default" } : undefined}
									{...testId(`${testIdPrefix}-${option.key}-row`)}
								>
									<span className="grid grid-cols-[16px_minmax(0,1fr)_minmax(0,1fr)] items-baseline gap-x-3">
										<Caret size={16} aria-hidden />
										{/* The badge follows the name's last word, on its line. */}
										<Text
											component="span"
											className={isOpen ? "col-span-2" : undefined}
											style={{ minWidth: 0, overflowWrap: "break-word" }}
										>
											{option.title}
											{option.beta && (
												<Badge
													component="span"
													color="mauve"
													c="graphite"
													size="sm"
													ml="xs"
													style={{ verticalAlign: "middle" }}
													{...testId(`${testIdPrefix}-${option.key}-beta`)}
												>
													<Trans>Beta</Trans>
												</Badge>
											)}
										</Text>
										{!isOpen && (
											<Text
												component="span"
												size="sm"
												className="app-muted"
												truncate="end"
												{...testId(`${testIdPrefix}-${option.key}-summary`)}
											>
												{option.summary}
											</Text>
										)}
									</span>
								</UnstyledButton>
							</Title>
							{isOpen && (
								<section
									id={bodyId}
									aria-labelledby={headerId}
									{...testId(`${testIdPrefix}-${option.key}-body`)}
								>
									<Stack gap="lg" px="sm" pt="md" pb="lg">
										<ShownTitleContext.Provider value={option.title}>
											{option.body}
										</ShownTitleContext.Provider>
										{/* A row of steps: Back on the left, Next on the right (rules.css),
										    where it stays on the first option too. */}
										<Group data-steps justify="space-between" gap="sm">
											{i > 0 ? (
												<Button
													variant="subtle"
													size="sm"
													onClick={() => onOpen(options[i - 1].key, "back")}
													{...testId(`${testIdPrefix}-back`)}
												>
													<Trans>Back</Trans>
												</Button>
											) : (
												<span />
											)}
											{(!isLast || onNextPage) && (
												<Button
													variant="filled"
													size="sm"
													onClick={() => {
														if (isLast) onNextPage?.();
														else onOpen(options[i + 1].key, "next");
													}}
													{...testId(`${testIdPrefix}-next`)}
												>
													{isLast && nextLabel ? nextLabel : t`Next`}
												</Button>
											)}
										</Group>
									</Stack>
								</section>
							)}
						</li>
					);
				})}
			</Stack>
		</Stack>
	);
};
