import { t } from "@lingui/core/macro";
import { ActionIcon, Badge, Group, Stack, TextInput } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useState } from "react";
import { testId } from "@/lib/testUtils";

const parseTerms = (value: string) =>
	value
		.split(",")
		.map((term) => term.trim())
		.filter(Boolean);

/**
 * Key terms are stored on the project as one comma-separated string
 * (default_conversation_transcript_prompt) and sent to transcription as
 * hotwords, so this input reads and writes that string directly.
 *
 * A typed term is committed on blur as well as on Enter: in the create
 * wizard the next click is "Next", and a term left in the field would
 * otherwise be dropped without the host noticing.
 */
export const KeyTermsInput = ({
	value,
	onChange,
	isDirty = false,
	autoFocus = false,
	inputTestId = "key-terms-input",
}: {
	value: string;
	onChange: (value: string) => void;
	isDirty?: boolean;
	autoFocus?: boolean;
	inputTestId?: string;
}) => {
	const [draft, setDraft] = useState("");
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
			<TextInput
				autoFocus={autoFocus}
				className={isDirty ? "border-blue-500" : ""}
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
								fontWeight: 500,
								textTransform: "none",
							}}
							rightSection={
								<ActionIcon
									onClick={() => removeTerm(term)}
									size="xs"
									variant="transparent"
									c="gray.8"
									aria-label={t`Remove ${term}`}
								>
									<IconX size={14} />
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
