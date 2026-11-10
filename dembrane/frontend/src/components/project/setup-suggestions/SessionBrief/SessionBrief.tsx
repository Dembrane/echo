import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Button, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { ListMagnifyingGlassIcon } from "@phosphor-icons/react";
import { useId } from "react";
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
	/** Hidden in the portal editor, which suggests from the project itself. */
	showInputs?: boolean;
	text?: string;
	url?: string;
	onTextChange?: (value: string) => void;
	onUrlChange?: (value: string) => void;
	/** False while there is nothing to suggest from. */
	canSuggest: boolean;
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
	/** Where the block sits; the empty and error lines say what to do there. */
	surface: "wizard" | "portal_editor";
}

/**
 * "Tell dembrane about your session": one text box, an optional link and "Suggest key
 * terms". Results appear in place: key terms as chips, then any settings worth changing.
 * Optional on every side: nothing here holds up creating the project, and a failure is
 * one quiet line. Props in, callbacks out; SessionBriefConnected does the request.
 */
export const SessionBrief = ({
	status,
	showInputs = true,
	text = "",
	url = "",
	onTextChange,
	onUrlChange,
	canSuggest,
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
	const headingId = useId();
	const loading = status === "loading";
	const empty =
		status === "results" && terms.length === 0 && settings.length === 0;
	const termCount = terms.length;
	const settingCount = settings.length;

	return (
		<Stack
			gap="sm"
			role="group"
			aria-labelledby={showInputs ? headingId : undefined}
			aria-label={showInputs ? undefined : t`Suggested key terms`}
			data-tour="setup-suggestions"
			{...testId("setup-suggestions")}
		>
			{showInputs ? (
				<>
					<Stack gap="xs">
						<Text size="md" component="h3" m={0} id={headingId}>
							<Trans>Tell dembrane about your session</Trans>
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>
								Optional. dembrane suggests the names and words transcription
								should spell right, and any settings worth changing.
							</Trans>
						</Text>
					</Stack>
					<Textarea
						aria-label={t`About your session`}
						placeholder={t`What is it about, who takes part and where? You can also paste the agenda or the invitation.`}
						autosize
						minRows={3}
						maxRows={10}
						value={text}
						onChange={(e) => onTextChange?.(e.currentTarget.value)}
						{...testId("setup-suggestions-text")}
					/>
					<TextInput
						label={t`Link to a page about it`}
						description={t`Optional. An invitation or project page; dembrane reads it once.`}
						placeholder="https://"
						type="url"
						inputMode="url"
						value={url}
						onChange={(e) => onUrlChange?.(e.currentTarget.value)}
						{...testId("setup-suggestions-url")}
					/>
				</>
			) : null}

			<Button
				variant="outline"
				size="sm"
				w="fit-content"
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
					<VisuallyHiddenSummary terms={termCount} settings={settingCount} />
				) : null}
			</div>

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
