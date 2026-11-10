import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { FileArrowUpIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { TemplateSummary } from "@/components/project/templates/projectTemplates";
import { track } from "@/lib/analytics/events";
import { testId } from "@/lib/testUtils";
import { DigestEntry, type DigestMaterial } from "./DigestEntry/DigestEntry";
import { DigestProgress, FileList } from "./DigestProgress/DigestProgress";
import { DigestReview } from "./DigestReview/DigestReview";
import type { DigestFailure, DigestResult } from "./digest";
import { useDigestCatalog } from "./i18n";
import { CONTEXT_BUDGET, cutToBudget, DIGEST_ACCEPT } from "./limits";
import {
	appliedCounts,
	type DigestCreateBody,
	initialReview,
	type ReviewState,
	sectionsShown,
	toCreateBody,
} from "./review";
import { useDigestRun } from "./useDigestRun";

export interface DigestFallback {
	/** The material's text, cut to the context budget; "" when there was none. */
	context: string;
	/** The material was longer than the context holds. */
	cut: boolean;
	cause: DigestFailure;
}

interface DigestConnectedProps {
	workspaceId: string | null;
	/** The new project's language: what the digest writes in. */
	language: string;
	templates: readonly TemplateSummary[] | undefined;
	/** True while files are read, the digest runs or its review shows: the picker steps aside. */
	onActiveChange: (active: boolean) => void;
	/** The digest failed or found nothing: the picker takes over with the text in the context. */
	onFallback: (fallback: DigestFallback) => void;
	/** Creates the project; resolves true once it exists. */
	onCreate: (body: DigestCreateBody) => Promise<boolean>;
	creating: boolean;
	/** Dropping a file anywhere on the page starts it too. */
	pageDrop?: boolean;
}

/**
 * The digest on the template picker (ECHO-1055): the entry row, the reading states, the
 * review, and the fallback to the picker. Fetching, extraction and analytics live here;
 * the blocks only show.
 */
export const DigestConnected = ({
	workspaceId,
	language,
	templates,
	onActiveChange,
	onFallback,
	onCreate,
	creating,
	pageDrop = true,
}: DigestConnectedProps) => {
	const ready = useDigestCatalog();
	const digest = useDigestRun({ language, surface: "picker", workspaceId });
	const [result, setResult] = useState<DigestResult | null>(null);
	const [review, setReview] = useState<ReviewState | null>(null);
	const [fallback, setFallback] = useState<DigestFallback | null>(null);
	const active =
		digest.phase === "files" || digest.phase === "material" || result !== null;
	const onActive = useRef(onActiveChange);
	onActive.current = onActiveChange;
	useEffect(() => onActive.current(active), [active]);

	const start = async (m: DigestMaterial) => {
		setFallback(null);
		setResult(null);
		const outcome = await digest.run(m);
		if (!outcome) return;
		if (outcome.result) {
			setResult(outcome.result);
			setReview(initialReview(outcome.result, templates ?? []));
			window.scrollTo?.({ behavior: "smooth", top: 0 });
			return;
		}
		const cause = outcome.cause ?? "error";
		// Nothing readable at all: the file list says why, the picker is untouched.
		if (cause === "no_readable_files") return;
		const next = {
			cause,
			context: cutToBudget(outcome.text, CONTEXT_BUDGET),
			cut: outcome.text.length > CONTEXT_BUDGET,
		};
		setFallback(next);
		onFallback(next);
	};

	const startOver = () => {
		setResult(null);
		setReview(null);
		digest.reset();
	};

	const create = async () => {
		if (!result || !review) return;
		const body = toCreateBody(review);
		if (!body) return;
		const created = await onCreate(body);
		if (created)
			track(
				"project_digest_applied",
				appliedCounts(
					review,
					sectionsShown(result),
					result.template?.key ?? null,
				),
			);
	};

	if (!ready) return null;

	if (result && review)
		return (
			<DigestReview
				result={result}
				value={review}
				onChange={setReview}
				templates={templates ?? []}
				creating={creating}
				onCreate={() => void create()}
				onStartOver={startOver}
			/>
		);

	if (digest.phase === "files" || digest.phase === "material")
		return (
			<DigestProgress
				files={digest.files}
				phase={digest.phase}
				onCancel={digest.cancel}
			/>
		);

	const refused = digest.files.length > 0 && digest.phase === "failed";
	return (
		<>
			<DigestEntry
				onSubmit={(m) => void start(m)}
				notice={
					<Stack gap="xs" aria-live="polite">
						{refused && !fallback ? <FileList files={digest.files} /> : null}
						{fallback ? <FallbackNotice fallback={fallback} /> : null}
					</Stack>
				}
			/>
			{pageDrop ? (
				<Dropzone.FullScreen
					active
					accept={DIGEST_ACCEPT}
					onDrop={() => {}}
					onDropAny={(files, rejections) =>
						void start({
							files: [...files, ...rejections.map((r) => r.file)],
							text: "",
							url: "",
						})
					}
					{...testId("project-digest-page-drop")}
				>
					<Stack align="center" justify="center" mih="40vh" gap="xs">
						<FileArrowUpIcon size={32} aria-hidden />
						<Text size="lg">
							<Trans>Drop it to set up the project from it</Trans>
						</Text>
					</Stack>
				</Dropzone.FullScreen>
			) : null}
		</>
	);
};

const FallbackNotice = ({ fallback }: { fallback: DigestFallback }) => (
	<Stack gap={4} {...testId("project-digest-fallback")}>
		<Text size="sm">
			{fallback.cause === "budget" ? (
				<Trans>
					Your workspace's AI budget for this month is used up, so dembrane
					can't read this now.
				</Trans>
			) : fallback.cause === "rate_limited" ? (
				<Trans>
					You've set up several projects from material in the last hour. Try
					again later.
				</Trans>
			) : (
				<Trans>dembrane couldn't set the project up from this.</Trans>
			)}{" "}
			{fallback.context ? (
				<Trans>
					Your text is in the project context: choose a template below to
					continue.
				</Trans>
			) : (
				<Trans>Choose a template below to continue.</Trans>
			)}
		</Text>
		{fallback.cut ? (
			<Text size="xs" className="app-muted">
				<Trans>
					Only its start fits: dembrane reads the first 4,000 characters of the
					context.
				</Trans>
			</Text>
		) : null}
	</Stack>
);

export default DigestConnected;
