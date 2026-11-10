import { track } from "@/lib/analytics/events";
import { SessionBrief } from "../SessionBrief/SessionBrief";
import { addTerms, hasTerm, splitTerms } from "../setupSuggestions";
import { useSuggestionBlock } from "../useSuggestionBlock";

interface SuggestKeyTermsConnectedProps {
	project: {
		workspace_id: string | null;
		name: string | null;
		context: string | null;
		language: string | null;
		/** Not on every project read; a project without one suggests as blank. */
		template_key?: string | null;
	};
	/** The key terms field's value in the portal editor's form. */
	value: string;
	onChange: (value: string) => void;
}

/**
 * "Suggest key terms" next to the key terms field in the portal editor: the same block
 * and endpoint as the create wizard, reading the project's name, context and the terms it
 * already has. Key terms only; settings have their own screens here. Accepting changes
 * the form, which the host saves as any other edit.
 */
export const SuggestKeyTermsConnected = ({
	project,
	value,
	onChange,
}: SuggestKeyTermsConnectedProps) => {
	const block = useSuggestionBlock({
		keyTerms: value,
		onKeyTermsChange: onChange,
		surface: "portal_editor",
		workspaceId: project.workspace_id,
	});
	const accepted = (count: number) => {
		if (count > 0)
			track("project_setup_ai_accepted", {
				settings_accepted: 0,
				surface: "portal_editor",
				terms_accepted: count,
			});
	};

	return (
		<SessionBrief
			surface="portal_editor"
			showInputs={false}
			status={block.status}
			canSuggest={Boolean(
				project.workspace_id &&
					(project.name?.trim() || project.context?.trim()),
			)}
			onSuggest={() =>
				block.suggest({
					description: project.context?.trim() || null,
					existing_key_terms: splitTerms(value),
					include_settings: false,
					language: project.language || "en",
					name: project.name?.trim() ?? "",
					template_key: project.template_key || "blank",
				})
			}
			terms={block.terms}
			settings={[]}
			notes={block.notes}
			isAccepted={block.isAccepted}
			totalTerms={block.totalTerms}
			onToggleTerm={(term) => {
				if (!hasTerm(value, term)) accepted(1);
				block.toggle(term);
			}}
			onRemoveTerm={block.remove}
			onAcceptAll={() => {
				const before = splitTerms(value).length;
				const after = splitTerms(
					addTerms(
						value,
						block.terms.map((t) => t.term),
					),
				).length;
				accepted(after - before);
				block.acceptAll();
			}}
			checkedSettings={{}}
			onToggleSetting={() => {}}
		/>
	);
};
