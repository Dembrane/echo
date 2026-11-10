import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Button, Collapse, Group, Stack, Text, TextInput } from "@mantine/core";
import {
	CaretDownIcon,
	CaretRightIcon,
	ListMagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useId, useState } from "react";
import { SuggestionCardFrame } from "@/components/common/SuggestionCardFrame";
import { testId } from "@/lib/testUtils";
import { SuggestedSettings } from "../SuggestedSettings/SuggestedSettings";
import { SuggestedTerms } from "../SuggestedTerms/SuggestedTerms";
import type {
	ProposedSetting,
	ProposedTerm,
	SuggestionNote,
} from "../setupSuggestions";

export type BriefStatus = "idle" | "loading" | "results" | "error";

export interface SessionBriefProps {
	status: BriefStatus;
	/** The create wizard offers an optional link behind "Add a link"; the portal editor does not. */
	withLink?: boolean;
	url?: string;
	onUrlChange?: (value: string) => void;
	/** False while there is nothing to suggest from. */
	canSuggest: boolean;
	/** What to do first, shown under the action while it cannot run. */
	hint?: ReactNode;
	/** The project context was longer than a request reads: only its start was read. */
	readStartOnly?: boolean;
	onSuggest: () => void;
	terms: readonly ProposedTerm[];
	settings: readonly ProposedSetting[];
	notes: readonly SuggestionNote[];
	isAccepted: (term: string) => boolean;
	totalTerms: number;
	onToggleTerm: (term: string) => void;
	onRemoveTerm: (term: string) => void;
	onAcceptAll: () => void;
	checkedSettings: Readonly<Record<string, boolean>>;
	onToggleSetting: (field: string, checked: boolean) => void;
	/** Where the block sits; the error line says what to do there. */
	surface: "wizard" | "portal_editor";
}

/**
 * "Suggest key terms" under the project context: dembrane reads what the host wrote
 * there (and, in the wizard, an optional link behind "Add a link") and proposes key
 * terms as chips, then any settings worth changing. No field of its own: the context is
 * the one place a host describes the session. Never in the way: nothing here holds up
 * creating the project, and a failure is one quiet line. Props in, callbacks out.
 */
export const SessionBrief = ({
	status,
	withLink = false,
	url = "",
	onUrlChange,
	canSuggest,
	hint,
	readStartOnly = false,
	onSuggest,
	terms,
	settings,
	notes,
	isAccepted,
	totalTerms,
	onToggleTerm,
	onRemoveTerm,
	onAcceptAll,
	checkedSettings,
	onToggleSetting,
	surface,
}: SessionBriefProps) => {
	const linkId = useId();
	const [linkOpen, setLinkOpen] = useState(false);
	const loading = status === "loading";
	const empty =
		status === "results" && terms.length === 0 && settings.length === 0;
	const showLink = linkOpen || url.trim() !== "";

	return (
		<Stack
			gap="sm"
			role="group"
			aria-label={t`Suggested key terms`}
			data-tour="setup-suggestions"
			{...testId("setup-suggestions")}
		>
			<Group gap="xs" wrap="wrap">
				<Button
					variant="outline"
					size="sm"
					leftSection={<ListMagnifyingGlassIcon size={16} aria-hidden />}
					loading={loading}
					disabled={!canSuggest}
					onClick={onSuggest}
					{...testId("setup-suggestions-submit")}
				>
					{status === "results" ? (
						<Trans>Suggest again</Trans>
					) : (
						<Trans>Suggest key terms</Trans>
					)}
				</Button>
				{withLink ? (
					<Button
						variant="subtle"
						size="sm"
						leftSection={
							showLink ? (
								<CaretDownIcon size={16} aria-hidden />
							) : (
								<CaretRightIcon size={16} aria-hidden />
							)
						}
						aria-expanded={showLink}
						aria-controls={linkId}
						onClick={() => setLinkOpen((open) => !open)}
						{...testId("setup-suggestions-link-toggle")}
					>
						<Trans>Add a link</Trans>
					</Button>
				) : null}
			</Group>

			{withLink ? (
				<Collapse in={showLink}>
					<TextInput
						id={linkId}
						label={t`Link to a page about it`}
						description={t`Optional. An invitation or project page; dembrane reads it once.`}
						placeholder="https://"
						type="url"
						inputMode="url"
						value={url}
						onChange={(e) => onUrlChange?.(e.currentTarget.value)}
						{...testId("setup-suggestions-url")}
					/>
				</Collapse>
			) : null}

			{!canSuggest && hint ? (
				<Text size="xs" c="dimmed" {...testId("setup-suggestions-hint")}>
					{hint}
				</Text>
			) : null}

			{/* One polite live region: the start of a request, its result and a failure are
			    read out once each, without moving focus. */}
			<div aria-live="polite" {...testId("setup-suggestions-status")}>
				{loading ? (
					<Text size="sm" c="dimmed">
						<Trans>Reading what you wrote…</Trans>
					</Text>
				) : null}
				{status === "error" ? (
					<Text size="sm" c="dimmed" {...testId("setup-suggestions-error")}>
						{surface === "wizard" ? (
							<Trans>
								Suggestions are not available right now. You can create the
								project without them.
							</Trans>
						) : (
							<Trans>
								Suggestions are not available right now. You can add key terms
								yourself.
							</Trans>
						)}
					</Text>
				) : null}
				{empty ? (
					<Text size="sm" c="dimmed" {...testId("setup-suggestions-empty")}>
						<Trans>
							Nothing to suggest from this. Names, places and abbreviations help
							most.
						</Trans>
					</Text>
				) : null}
				{status === "results" && !empty ? (
					<VisuallyHiddenSummary
						terms={terms.length}
						settings={settings.length}
					/>
				) : null}
			</div>

			{status !== "idle" && readStartOnly ? (
				<Text size="xs" c="dimmed" {...testId("setup-suggestions-long-note")}>
					<Trans>
						Your project context is long, so suggestions read its first 20,000
						characters. The whole text is saved.
					</Trans>
				</Text>
			) : null}

			{status === "results" && notes.includes("url_not_read") ? (
				<Text size="xs" c="dimmed" {...testId("setup-suggestions-url-note")}>
					<Trans>
						The link could not be read, so these come from what you wrote.
					</Trans>
				</Text>
			) : null}

			{status === "results" && !empty ? (
				<SuggestionCardFrame testId="setup-suggestions-results">
					<Stack gap="lg">
						{terms.length > 0 ? (
							<SuggestedTerms
								terms={terms}
								isAccepted={isAccepted}
								total={totalTerms}
								onToggle={onToggleTerm}
								onRemove={onRemoveTerm}
								onAcceptAll={onAcceptAll}
							/>
						) : null}
						{settings.length > 0 ? (
							<SuggestedSettings
								settings={settings}
								checked={checkedSettings}
								onToggle={onToggleSetting}
							/>
						) : null}
					</Stack>
				</SuggestionCardFrame>
			) : null}
		</Stack>
	);
};

const VisuallyHiddenSummary = ({
	terms,
	settings,
}: {
	terms: number;
	settings: number;
}) => (
	<span className="sr-only">
		<Plural
			value={terms}
			one="# key term suggested."
			other="# key terms suggested."
		/>{" "}
		{settings > 0 ? (
			<Plural
				value={settings}
				one="# setting suggested."
				other="# settings suggested."
			/>
		) : null}
	</span>
);
