import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
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
import { FlowProgress } from "@/components/project/templates/FlowProgress/FlowProgress";
import { testId } from "@/lib/testUtils";

const RULE = "var(--app-stroke) solid var(--app-rule-color)";

export interface StepperOption {
	key: string;
	title: string;
	/** The option's current value in one line, shown while it is closed. */
	summary: ReactNode;
	/** The option's field, shown while it is open. */
	body: ReactNode;
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
 * row. Props in, callbacks out.
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
								borderBottom: RULE,
								borderTop: i === 0 ? RULE : undefined,
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
									className="app-do block w-full"
									px="xs"
									py="sm"
									{...testId(`${testIdPrefix}-${option.key}-row`)}
								>
									<Group gap="sm" wrap="nowrap" align="baseline">
										<Caret size={16} aria-hidden style={{ flexShrink: 0 }} />
										<Text
											component="span"
											w={{ base: 112, sm: 168 }}
											style={{ flexShrink: 0 }}
										>
											{option.title}
										</Text>
										{!isOpen && (
											<Text
												component="span"
												size="sm"
												className="app-muted"
												truncate="end"
												style={{ flex: 1, minWidth: 0 }}
												{...testId(`${testIdPrefix}-${option.key}-summary`)}
											>
												{option.summary}
											</Text>
										)}
									</Group>
								</UnstyledButton>
							</Title>
							{isOpen && (
								<section
									id={bodyId}
									aria-labelledby={headerId}
									{...testId(`${testIdPrefix}-${option.key}-body`)}
								>
									<Stack gap="lg" px="xs" pb="md" pt="xs">
										{option.body}
										<Group gap="sm">
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
											{i > 0 && (
												<Button
													variant="subtle"
													size="sm"
													onClick={() => onOpen(options[i - 1].key, "back")}
													{...testId(`${testIdPrefix}-back`)}
												>
													<Trans>Back</Trans>
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
