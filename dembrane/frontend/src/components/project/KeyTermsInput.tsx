import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Group,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useFocusOnHash } from "@/hooks/useFocusOnHash";
import { testId } from "@/lib/testUtils";

export const KEY_TERMS_HASH = "key-terms";

const parseTerms = (value: string) =>
	value
		.split(",")
		.map((term) => term.trim())
		.filter(Boolean);

/** What key terms do, said once: above the input, or behind the "i" beside its heading. */
export const KeyTermsExplanation = ({ inTip = false }: { inTip?: boolean }) => {
	// In an "i" tip the three lines take the tip's own type size and sit closer.
	const line = inTip
		? ({ component: "span", display: "block", inherit: true } as const)
		: ({ size: "sm" } as const);
	return (
		<Stack gap={inTip ? 4 : "xs"} component={inTip ? "span" : "div"}>
			<Text {...line}>
				<Trans>
					Key terms tell transcription how to spell the names and words that
					matter in this project.
				</Trans>
			</Text>
			<Text {...line}>
				<Trans>
					Without them, a name or word the transcription model does not know
					often comes out misspelt. Adding them now improves everything built on
					the transcripts: summaries, chats, reports and the library.
				</Trans>
			</Text>
			<Text {...line}>
				<Trans>
					Add the people, places, organisations and jargon you expect to hear.
				</Trans>
			</Text>
		</Stack>
	);
};

/**
 * Key terms are stored on the project as one comma-separated string
 * (default_conversation_transcript_prompt) and sent to transcription as
 * hotwords, so this input reads and writes that string directly.
 *
 * The explanation of what key terms do lives here, with the control, so
 * the create wizard and the portal editor say the same thing.
 *
 * A typed term is committed on blur as well as on Enter: in the create
 * wizard the next click is "Next", and a term left in the field would
 * otherwise be dropped without the host noticing.
 */
export const KeyTermsInput = ({
	value,
	onChange,
	autoFocus = false,
	inputTestId = "key-terms-input",
	explained = true,
}: {
	value: string;
	onChange: (value: string) => void;
	/** Accepted for callers that track it; the section around the input shows the dirty mark. */
	isDirty?: boolean;
	autoFocus?: boolean;
	inputTestId?: string;
	/** False where the explanation sits behind an "i" beside the heading (the create page). */
	explained?: boolean;
}) => {
	const [draft, setDraft] = useState("");
	const inputRef = useFocusOnHash<HTMLInputElement>(KEY_TERMS_HASH);
	const terms = parseTerms(value);

	const commitDraft = () => {
		const added = parseTerms(draft);
		if (added.length === 0) return;
		onChange(Array.from(new Set([...terms, ...added])).join(", "));
		setDraft("");
	};

	const removeTerm = (term: string) => {
		onChange(terms.filter((existing) => existing !== term).join(", "));
	};

	return (
		<Stack gap="sm">
			{explained && <KeyTermsExplanation />}
			<TextInput
				ref={inputRef}
				autoFocus={autoFocus}
				aria-label={t`Key terms`}
				description={t`Press Enter to add. Separate several with commas.`}
				inputWrapperOrder={["label", "input", "description", "error"]}
				value={draft}
				onChange={(e) => setDraft(e.currentTarget.value)}
				onBlur={commitDraft}
				placeholder={t`Enter a key term or proper noun`}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commitDraft();
					}
				}}
				{...testId(inputTestId)}
			/>
			{terms.length > 0 && (
				<Group gap="xs">
					{terms.map((term) => (
						<Badge
							key={term}
							variant="light"
							c="var(--app-text)"
							size="lg"
							style={{
								textTransform: "none",
							}}
							rightSection={
								<ActionIcon
									onClick={() => removeTerm(term)}
									size="xs"
									variant="transparent"
									aria-label={t`Remove ${term}`}
								>
									<XIcon size={16} />
								</ActionIcon>
							}
						>
							<span>{term}</span>
						</Badge>
					))}
				</Group>
			)}
		</Stack>
	);
};
