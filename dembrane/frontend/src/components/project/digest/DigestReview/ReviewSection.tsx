import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { testId } from "@/lib/testUtils";
import type { DigestProvenance } from "../digest";
import { Provenance } from "./Provenance";

interface ReviewSectionProps {
	id: string;
	title: string;
	/** What the part sets up, in one quiet line. */
	hint?: ReactNode;
	provenance?: DigestProvenance | null;
	/** Above the part, on the first screen only: what this review is. */
	intro?: ReactNode;
	/** The part: read, or its field when editing. */
	children: ReactNode;
	/** Shown, and moves focus to the heading, when this screen opens. */
	stepKey: string;
	/** The part is skipped (off): said under it. */
	skipped?: boolean;
	/** Editing: focus moves into the part. Absent for parts edited as they show. */
	editing?: boolean;
	onEdit?: () => void;
	/** Absent for parts that cannot be skipped (the name, the template). */
	onSkip?: () => void;
	onAccept: () => void;
	canAccept?: boolean;
	/** The quiet way back, and the quiet way to the end. */
	footer: ReactNode;
}

/**
 * One part of what dembrane understood, on a screen of its own (ECHO-1058): its title,
 * where it came from, the part, and three actions: accept and continue (Enter), edit in
 * place, skip. Enter in a one-line field accepts too; in a text box Ctrl or Cmd with Enter
 * does. Fields that use Enter themselves (tags, the template list) are marked
 * data-own-enter and keep it.
 */
export const ReviewSection = ({
	id,
	title,
	hint,
	provenance,
	intro,
	children,
	stepKey,
	skipped = false,
	editing,
	onEdit,
	onSkip,
	onAccept,
	canAccept = true,
	footer,
}: ReviewSectionProps) => {
	const headingRef = useRef<HTMLHeadingElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new screen moves focus to its heading
	useEffect(() => {
		headingRef.current?.focus({ preventScroll: true });
	}, [stepKey]);
	useEffect(() => {
		if (!editing) return;
		bodyRef.current
			?.querySelector<HTMLElement>("input:not([type=hidden]), textarea")
			?.focus();
	}, [editing]);

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "Enter" || e.shiftKey || e.altKey) return;
		if (e.nativeEvent.isComposing || e.defaultPrevented) return;
		const el = e.target as HTMLElement;
		if (el.closest("[data-own-enter]")) return;
		if (["BUTTON", "A", "SELECT"].includes(el.tagName)) return;
		if (el.getAttribute("role") === "combobox") return;
		if (el.tagName === "TEXTAREA" && !(e.metaKey || e.ctrlKey)) return;
		if (el instanceof HTMLInputElement && el.type === "checkbox") return;
		e.preventDefault();
		if (canAccept) onAccept();
	};

	return (
		<Stack
			component="section"
			gap="lg"
			aria-labelledby={`project-digest-title-${id}`}
			onKeyDown={onKeyDown}
			data-tour={`project-digest-${id}`}
			{...testId(`project-digest-section-${id}`)}
		>
			<Stack gap="xs">
				<Text size="sm" className="app-muted">
					<Trans>Here is what dembrane understood</Trans>
				</Text>
				<Title
					order={3}
					ref={headingRef}
					tabIndex={-1}
					id={`project-digest-title-${id}`}
					style={{ outline: "none" }}
				>
					{title}
				</Title>
				{hint ? <Text size="sm">{hint}</Text> : null}
				{provenance ? (
					<Group gap="xs">
						<Provenance provenance={provenance} id={id} />
					</Group>
				) : null}
			</Stack>
			{intro}
			<div ref={bodyRef} {...testId(`project-digest-section-${id}-body`)}>
				{children}
			</div>
			{skipped ? (
				<Text
					size="sm"
					className="app-muted"
					{...testId(`project-digest-section-${id}-skipped`)}
				>
					<Trans>You skipped this part. Accept it to use it after all.</Trans>
				</Text>
			) : null}
			<Group gap="sm" wrap="wrap">
				<Button
					variant="filled"
					size="sm"
					onClick={onAccept}
					disabled={!canAccept}
					{...testId("project-digest-accept")}
				>
					<Trans>Accept and continue</Trans>
				</Button>
				{onEdit && !editing ? (
					<Button
						variant="outline"
						size="sm"
						onClick={onEdit}
						{...testId("project-digest-edit")}
					>
						<Trans>Edit</Trans>
					</Button>
				) : null}
				{onSkip ? (
					<Button
						variant="subtle"
						size="sm"
						onClick={onSkip}
						{...testId("project-digest-skip")}
					>
						<Trans>Skip this part</Trans>
					</Button>
				) : null}
			</Group>
			{footer}
		</Stack>
	);
};
