import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import { useState } from "react";
import { SuggestedTerms } from "@/components/project/setup-suggestions/SuggestedTerms/SuggestedTerms";
import {
	addTerms,
	hasTerm,
	removeTerm,
	splitTerms,
} from "@/components/project/setup-suggestions/setupSuggestions";
import { testId } from "@/lib/testUtils";
import { DigestEntry, type DigestMaterial } from "../DigestEntry/DigestEntry";
import { DigestProgress, FileList } from "../DigestProgress/DigestProgress";
import type { DigestTerm } from "../digest";
import { useDigestCatalog } from "../i18n";
import { useDigestRun } from "../useDigestRun";

interface NameStepDigestProps {
	workspaceId: string | null;
	language: string;
	name: string;
	context: string;
	keyTerms: string;
	onContextChange: (value: string) => void;
	onKeyTermsChange: (value: string) => void;
}

/**
 * On the name step, for a host who picked a template by hand: a small drop zone beside
 * "Suggest key terms". dembrane reads the material, adds its condensed context to the
 * project context and proposes key terms as the suggestions do. Nothing else changes.
 */
export const NameStepDigestConnected = ({
	workspaceId,
	language,
	name,
	context,
	keyTerms,
	onContextChange,
	onKeyTermsChange,
}: NameStepDigestProps) => {
	const ready = useDigestCatalog();
	const digest = useDigestRun({ language, surface: "name_step", workspaceId });
	const [terms, setTerms] = useState<DigestTerm[]>([]);
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
	const [outcome, setOutcome] = useState<"added" | "nothing" | null>(null);

	const start = async (m: DigestMaterial) => {
		setOutcome(null);
		const done = await digest.run(m, {
			context: context.slice(0, 20_000) || undefined,
			key_terms: splitTerms(keyTerms),
			name: name || undefined,
		});
		if (!done) return;
		const r = done.result;
		if (!r) {
			// Nothing readable at all: the file list says why.
			setOutcome(done.cause === "no_readable_files" ? null : "nothing");
			return;
		}
		if (r.context)
			onContextChange(
				context.trim() ? `${context.trim()}\n\n${r.context}` : r.context,
			);
		setTerms(r.key_terms);
		setRemoved(new Set());
		setOutcome("added");
	};

	if (!ready) return null;
	const shown = terms.filter((x) => !removed.has(x.term));

	return (
		<Stack gap="xs" {...testId("project-digest-name-step")}>
			{digest.phase === "files" || digest.phase === "material" ? (
				<DigestProgress
					compact
					files={digest.files}
					phase={digest.phase}
					onCancel={digest.cancel}
				/>
			) : (
				<DigestEntry
					compact
					onSubmit={(m) => void start(m)}
					notice={
						<div aria-live="polite">
							{digest.phase === "failed" &&
							digest.files.some((f) => f.state === "refused") ? (
								<FileList files={digest.files} />
							) : null}
							{outcome === "nothing" ? (
								<Text
									size="sm"
									className="app-muted"
									{...testId("project-digest-name-step-nothing")}
								>
									<Trans>
										dembrane couldn't read anything to add from this.
									</Trans>
								</Text>
							) : null}
							{outcome === "added" ? (
								<Text size="sm" {...testId("project-digest-name-step-added")}>
									<Trans>
										Added what the session is about to the project context.
										Check it above.
									</Trans>
								</Text>
							) : null}
						</div>
					}
				/>
			)}
			{shown.length > 0 ? (
				<SuggestedTerms
					terms={shown.map((x) => ({
						reason: x.reason,
						source: "text",
						term: x.term,
					}))}
					isAccepted={(term) => hasTerm(keyTerms, term)}
					total={splitTerms(keyTerms).length}
					onToggle={(term) =>
						onKeyTermsChange(
							hasTerm(keyTerms, term)
								? removeTerm(keyTerms, term)
								: addTerms(keyTerms, [term]),
						)
					}
					onRemove={(term) => {
						setRemoved((prev) => new Set([...prev, term]));
						if (hasTerm(keyTerms, term))
							onKeyTermsChange(removeTerm(keyTerms, term));
					}}
					onAcceptAll={() =>
						onKeyTermsChange(
							addTerms(
								keyTerms,
								shown.map((x) => x.term),
							),
						)
					}
				/>
			) : null}
		</Stack>
	);
};

export default NameStepDigestConnected;
