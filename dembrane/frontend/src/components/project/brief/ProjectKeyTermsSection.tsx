import { t } from "@lingui/core/macro";
import { useEffect, useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { SaveStatus } from "@/components/form/SaveStatus";
import { useUpdateProjectByIdMutation } from "@/components/project/hooks";
import {
	KEY_TERMS_HASH,
	KeyTermsInput,
} from "@/components/project/KeyTermsInput";
import { ProjectSettingsSection } from "@/components/project/ProjectSettingsSection";
import { LazySuggestKeyTerms } from "@/components/project/setup-suggestions/lazy";
import { useAutoSave } from "@/hooks/useAutoSave";
import { changedFields, keyTermCount, track } from "@/lib/analytics/events";
import { testId } from "@/lib/testUtils";

interface Values {
	default_conversation_transcript_prompt: string;
}

/**
 * The project's key terms in Brief (ECHO-1060), with the portal editor's save model: each
 * change saves itself a second later, and the same events say so. The suggestion block
 * reads the project's name and context, as it did in the portal editor.
 */
export const ProjectKeyTermsSection = ({
	project,
	readOnly = false,
}: {
	project: Project;
	readOnly?: boolean;
}) => {
	const initial = project.default_conversation_transcript_prompt ?? "";
	const { control, watch, reset, formState } = useForm<Values>({
		defaultValues: { default_conversation_transcript_prompt: initial },
	});
	const updateProjectMutation = useUpdateProjectByIdMutation();
	const savedRef = useRef<Record<string, unknown>>({
		default_conversation_transcript_prompt: initial,
	});

	const onSave = async (values: Values) => {
		await updateProjectMutation.mutateAsync({
			id: project.id,
			payload: values,
		});
		const fieldsChanged = changedFields(savedRef.current, { ...values });
		savedRef.current = { ...values };
		if (fieldsChanged.length > 0) {
			track("portal_settings_saved", {
				fields_changed: fieldsChanged,
				project_id: project.id,
			});
			track("key_terms_updated", {
				count: keyTermCount(values.default_conversation_transcript_prompt),
				project_id: project.id,
				surface: "brief",
			});
		}
		reset(values, { keepDirty: false, keepValues: true });
	};

	const { dispatchAutoSave, isPendingSave, isSaving, isError, lastSavedAt } =
		useAutoSave({
			initialLastSavedAt: project.updated_at ?? new Date(),
			onSave,
		});
	const dispatchRef = useRef(dispatchAutoSave);
	dispatchRef.current = dispatchAutoSave;

	useEffect(() => {
		if (readOnly) return;
		const subscription = watch((values, { type }) => {
			if (type === "change" && values) dispatchRef.current(values as Values);
		});
		return () => subscription.unsubscribe();
	}, [watch, readOnly]);

	return (
		<ProjectSettingsSection
			id={`${KEY_TERMS_HASH}-section`}
			title={t`Key terms`}
			headerRight={
				readOnly ? undefined : (
					<SaveStatus
						savedAt={lastSavedAt}
						formErrors={formState.errors}
						isPendingSave={isPendingSave}
						isSaving={isSaving}
						isError={isError}
					/>
				)
			}
		>
			<fieldset
				disabled={readOnly}
				inert={readOnly}
				className="m-0 min-w-0 border-0 p-0"
				{...testId("project-brief-key-terms")}
			>
				<Controller
					name="default_conversation_transcript_prompt"
					control={control}
					render={({ field }) => (
						<>
							<KeyTermsInput
								value={field.value}
								onChange={field.onChange}
								isDirty={
									!!formState.dirtyFields.default_conversation_transcript_prompt
								}
								inputTestId="portal-editor-specific-context-input"
							/>
							<LazySuggestKeyTerms
								project={project}
								value={field.value}
								onChange={field.onChange}
							/>
						</>
					)}
				/>
			</fieldset>
		</ProjectSettingsSection>
	);
};
