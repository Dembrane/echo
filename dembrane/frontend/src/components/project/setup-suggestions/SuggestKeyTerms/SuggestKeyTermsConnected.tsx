import { Trans } from "@lingui/react/macro";
import { Anchor } from "@mantine/core";
import { I18nLink } from "@/components/common/i18nLink";
import { PROJECT_CONTEXT_HASH } from "@/components/project/ProjectContextInput";
import { track } from "@/lib/analytics/events";
import { SessionBrief } from "../SessionBrief/SessionBrief";
import {
	addTerms,
	hasTerm,
	MAX_SOURCE_CHARS,
	splitTerms,
} from "../setupSuggestions";
import { useSuggestionBlock } from "../useSuggestionBlock";

interface SuggestKeyTermsConnectedProps {
	project: {
		id: string;
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
 * and endpoint as the create wizard, reading the project's saved name, context and the
 * terms it already has. No field of its own: with no context yet, the hint sends the host
 * to the context field first. Key terms only; settings have their own screens here. Accepting changes
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

	const context = project.context?.trim() ?? "";
	const contextLink = `/w/${project.workspace_id}/projects/${project.id}/brief#${PROJECT_CONTEXT_HASH}`;

	return (
		<SessionBrief
			surface="portal_editor"
			status={block.status}
			canSuggest={Boolean(project.workspace_id && context)}
			hint={
				<Trans>
					Describe the session in the{" "}
					<Anchor
						component={I18nLink}
						to={contextLink}
						size="xs"
						data-testid="setup-suggestions-context-link"
					>
						project context
					</Anchor>{" "}
					first, and dembrane suggests key terms from it.
				</Trans>
			}
			readStartOnly={context.length > MAX_SOURCE_CHARS}
			onSuggest={() =>
				block.suggest({
					description: context.slice(0, MAX_SOURCE_CHARS) || null,
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
