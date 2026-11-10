import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Stack, Text, Textarea, type TextareaProps } from "@mantine/core";
import { useMergedRef } from "@mantine/hooks";
import { forwardRef } from "react";
import { useFocusOnHash } from "@/hooks/useFocusOnHash";

export const PROJECT_CONTEXT_HASH = "project-context";

/** Past this many characters the field says to keep the essentials (ECHO-1053). */
export const LONG_CONTEXT_CHARS = 2000;

/**
 * The project context field, with the one explanation of what it does.
 * The create wizard and project settings both render this, so the copy
 * lives with the control instead of being repeated per screen. A long
 * context gets a quiet note under it; nothing is cut.
 */
export const ProjectContextInput = forwardRef<
	HTMLTextAreaElement,
	TextareaProps
>((props, forwardedRef) => {
	const hashRef = useFocusOnHash<HTMLTextAreaElement>(PROJECT_CONTEXT_HASH);
	const ref = useMergedRef(hashRef, forwardedRef);
	const length = typeof props.value === "string" ? props.value.length : 0;

	return (
		<Stack gap={4}>
			<Textarea
				label={t`Project context`}
				description={t`Say what the session is about, who takes part and where; you can paste an agenda or invitation. dembrane uses it to keep chat answers, replies to participants and Popcorn on your question, and to suggest key terms.`}
				placeholder={t`What is it about, who takes part and where? You can also paste the agenda or the invitation.`}
				minRows={3}
				autosize
				{...props}
				ref={ref}
			/>
			{length > LONG_CONTEXT_CHARS && (
				<Text
					size="xs"
					className="app-muted"
					data-testid="project-context-long-note"
				>
					<Trans>
						Long context is read on every answer, so keep the essentials: the
						people, the places and the question.
					</Trans>
				</Text>
			)}
		</Stack>
	);
});

ProjectContextInput.displayName = "ProjectContextInput";
