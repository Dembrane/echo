import { useState } from "react";
import type { SetupSuggestions } from "../setupSuggestions";
import { useSuggestionBlock } from "../useSuggestionBlock";
import { SessionBrief } from "./SessionBrief";

export type SettingOverrides = Record<string, boolean | string>;

interface SessionBriefConnectedProps {
	workspaceId: string | null;
	templateKey: string;
	/** The project name and context the host typed above: part of what dembrane reads. */
	name: string;
	description: string;
	language: string;
	/** The key terms value the wizard submits (one comma-separated string). */
	keyTerms: string;
	onKeyTermsChange: (value: string) => void;
	/** Accepted settings, sent with the create as overrides on the template. */
	overrides: SettingOverrides;
	onOverridesChange: (overrides: SettingOverrides) => void;
	onResult?: (result: SetupSuggestions | null) => void;
}

/** SessionBrief in the create wizard, with the request and its analytics. */
export const SessionBriefConnected = ({
	workspaceId,
	templateKey,
	name,
	description,
	language,
	keyTerms,
	onKeyTermsChange,
	overrides,
	onOverridesChange,
	onResult,
}: SessionBriefConnectedProps) => {
	const [text, setText] = useState("");
	const [url, setUrl] = useState("");
	const block = useSuggestionBlock({
		keyTerms,
		onKeyTermsChange,
		onResult: (result) => {
			// A new answer replaces the old proposals, and with them what was ticked.
			onOverridesChange({});
			onResult?.(result);
		},
		surface: "wizard",
		workspaceId,
	});
	const canSuggest =
		Boolean(workspaceId) &&
		Boolean(text.trim() || url.trim() || description.trim() || name.trim());

	return (
		<SessionBrief
			surface="wizard"
			status={block.status}
			text={text}
			url={url}
			onTextChange={setText}
			onUrlChange={setUrl}
			canSuggest={canSuggest}
			onSuggest={() =>
				block.suggest({
					description: description.trim() || null,
					existing_key_terms: keyTerms
						.split(",")
						.map((term) => term.trim())
						.filter(Boolean),
					language,
					name: name.trim(),
					source_text: text.trim() || null,
					source_url: url.trim() || null,
					template_key: templateKey,
				})
			}
			terms={block.terms}
			settings={block.settings}
			notes={block.notes}
			isAccepted={block.isAccepted}
			totalTerms={block.totalTerms}
			onToggleTerm={block.toggle}
			onRemoveTerm={block.remove}
			onAcceptAll={block.acceptAll}
			checkedSettings={Object.fromEntries(
				Object.keys(overrides).map((field) => [field, true]),
			)}
			onToggleSetting={(field, checked) => {
				const setting = block.settings.find((s) => s.field === field);
				if (!setting) return;
				const next = { ...overrides };
				if (checked) next[field] = setting.proposed;
				else delete next[field];
				onOverridesChange(next);
			}}
		/>
	);
};
