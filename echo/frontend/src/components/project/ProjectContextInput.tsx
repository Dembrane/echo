import { t } from "@lingui/core/macro";
import { Textarea, type TextareaProps } from "@mantine/core";
import { useMergedRef } from "@mantine/hooks";
import { forwardRef } from "react";
import { useFocusOnHash } from "@/hooks/useFocusOnHash";

export const PROJECT_CONTEXT_HASH = "project-context";

/**
 * The project context field, with the one explanation of what it does.
 * The create wizard and project settings both render this, so the copy
 * lives with the control instead of being repeated per screen.
 */
export const ProjectContextInput = forwardRef<
	HTMLTextAreaElement,
	TextareaProps
>((props, forwardedRef) => {
	const hashRef = useFocusOnHash<HTMLTextAreaElement>(PROJECT_CONTEXT_HASH);
	const ref = useMergedRef(hashRef, forwardedRef);

	return (
		<Textarea
			label={t`Project context`}
			description={t`What this project is about and what you want to learn. dembrane uses it to keep chat answers, replies to participants and Popcorn on your question.`}
			placeholder={t`What are you trying to learn?`}
			minRows={3}
			autosize
			{...props}
			ref={ref}
		/>
	);
});

ProjectContextInput.displayName = "ProjectContextInput";
