import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Stack, Text, Textarea, type TextareaProps } from "@mantine/core";
import { useMergedRef } from "@mantine/hooks";
import { forwardRef, useId } from "react";
import { FieldWithInfo } from "@/components/common/InfoTip";
import { useFocusOnHash } from "@/hooks/useFocusOnHash";

export const PROJECT_CONTEXT_HASH = "project-context";

/**
 * Past this many characters the field says only the start is read (ECHO-1053). The same
 * number as the platform's prompt budget (PROJECT_CONTEXT_BUDGET in @dembrane/core,
 * ECHO-1055): every prompt reads at most this much of the context.
 */
export const LONG_CONTEXT_CHARS = 4000;

/**
 * The project context field, with the one explanation of what it does, behind the "i"
 * beside its label (Jor, 27 Nov 2026: less text up front).
 * The create wizard and project settings both render this, so the copy
 * lives with the control instead of being repeated per screen. A long
 * context gets a quiet note under it; the stored text is never cut, the
 * prompts read its first LONG_CONTEXT_CHARS characters.
 */
export const ProjectContextInput = forwardRef<
	HTMLTextAreaElement,
	TextareaProps
>((props, forwardedRef) => {
	const hashRef = useFocusOnHash<HTMLTextAreaElement>(PROJECT_CONTEXT_HASH);
	const ref = useMergedRef(hashRef, forwardedRef);
	const length = typeof props.value === "string" ? props.value.length : 0;
	const ownId = useId();
	const id = props.id ?? ownId;

	return (
		<Stack gap={4}>
			<FieldWithInfo
				htmlFor={id}
				title={t`Project context`}
				about={t`About the project context`}
				info={t`Say what the session is about, who takes part and where; you can paste an agenda or invitation. dembrane uses it to keep chat answers, replies to participants and Popcorn on your question, and to suggest key terms.`}
				testId="project-context-info"
			>
				<Textarea
					placeholder={t`What is it about, who takes part and where? You can also paste the agenda or the invitation.`}
					minRows={3}
					autosize
					{...props}
					id={id}
					ref={ref}
				/>
			</FieldWithInfo>
			{length > LONG_CONTEXT_CHARS && (
				<Text
					size="xs"
					className="app-muted"
					data-testid="project-context-long-note"
				>
					<Trans>
						dembrane reads the first 4,000 characters on every answer, so keep
						the essentials near the top: the people, the places and the
						question.
					</Trans>
				</Text>
			)}
		</Stack>
	);
});

ProjectContextInput.displayName = "ProjectContextInput";
