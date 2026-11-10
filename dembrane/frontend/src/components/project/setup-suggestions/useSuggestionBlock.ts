import { useState } from "react";
import { track } from "@/lib/analytics/events";
import type { BriefStatus } from "./SessionBrief/SessionBrief";
import {
	addTerms,
	failureCause,
	hasTerm,
	removeTerm,
	type SetupSuggestions,
	type SuggestionRequest,
	type SuggestionSurface,
	splitTerms,
	useSetupSuggestionsMutation,
} from "./setupSuggestions";

/**
 * The state both Connected wrappers share: the request, its result, the proposals the
 * host took away, and what accepting does to the key terms value. Analytics carry counts
 * and flags only, never the text, the link or the terms.
 */
export function useSuggestionBlock(o: {
	workspaceId: string | null;
	surface: SuggestionSurface;
	keyTerms: string;
	onKeyTermsChange: (value: string) => void;
	onResult?: (result: SetupSuggestions | null) => void;
}) {
	const mutation = useSetupSuggestionsMutation(o.workspaceId);
	const [result, setResult] = useState<SetupSuggestions | null>(null);
	const [failed, setFailed] = useState(false);
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());

	const status: BriefStatus = mutation.isPending
		? "loading"
		: failed
			? "error"
			: result
				? "results"
				: "idle";

	const suggest = (body: SuggestionRequest) => {
		setFailed(false);
		mutation.mutate(body, {
			onError: (error) => {
				setFailed(true);
				track("project_setup_ai_failed", {
					cause: failureCause(error),
					surface: o.surface,
				});
			},
			onSuccess: (data) => {
				setResult(data);
				setRemoved(new Set());
				o.onResult?.(data);
				track("project_setup_ai_suggested", {
					// The project context had content (it is the only text a host gives).
					has_text: Boolean(body.description?.trim()),
					has_url: Boolean(body.source_url?.trim()),
					settings_proposed: data.settings.length,
					surface: o.surface,
					template_key: body.template_key,
					terms_proposed: data.key_terms.length,
				});
			},
		});
	};

	const terms = (result?.key_terms ?? []).filter((t) => !removed.has(t.term));
	const isAccepted = (term: string) => hasTerm(o.keyTerms, term);

	const toggle = (term: string) =>
		o.onKeyTermsChange(
			isAccepted(term)
				? removeTerm(o.keyTerms, term)
				: addTerms(o.keyTerms, [term]),
		);
	const remove = (term: string) => {
		setRemoved((prev) => new Set([...prev, term]));
		if (isAccepted(term)) o.onKeyTermsChange(removeTerm(o.keyTerms, term));
	};
	const acceptAll = () =>
		o.onKeyTermsChange(
			addTerms(
				o.keyTerms,
				terms.map((t) => t.term),
			),
		);

	return {
		acceptAll,
		isAccepted,
		notes: result?.notes ?? [],
		remove,
		result,
		settings: result?.settings ?? [],
		status,
		suggest,
		terms,
		toggle,
		totalTerms: splitTerms(o.keyTerms).length,
	};
}
