import { zodResolver } from "@hookform/resolvers/zod";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Stack, Textarea, TextInput } from "@mantine/core";
import type React from "react";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { useAutoSave } from "@/hooks/useAutoSave";
import { testId } from "@/lib/testUtils";
import { FormLabel } from "../form/FormLabel";
import { SaveStatus } from "../form/SaveStatus";
import { useUpdateProjectByIdMutation } from "./hooks";
import { ProjectSettingsSection } from "./ProjectSettingsSection";

type ProjectBasicEditProps = {
	project: Project;
};

export const ProjectBasicEdit: React.FC<ProjectBasicEditProps> = ({
	project,
}) => {
	const FormSchema = z.object({
		context: z.string().optional(),
		name: z.string().min(4, t`Project name must be at least 4 characters long`),
	});

	type TFormSchema = z.infer<typeof FormSchema>;

	const { control, handleSubmit, watch, trigger, formState, reset } =
		useForm<TFormSchema>({
			defaultValues: {
				context: project.context ?? "",
				name: project.name ?? "",
			},
			mode: "onChange",
			resolver: zodResolver(FormSchema),
			reValidateMode: "onChange",
		});

	const updateProjectMutation = useUpdateProjectByIdMutation();

	const onSave = async (values: TFormSchema) => {
		await updateProjectMutation.mutateAsync({
			id: project.id,
			payload: values,
		});
		reset(values, { keepDirty: false, keepValues: true });
	};

	const {
		dispatchAutoSave,
		triggerManualSave,
		isPendingSave,
		isSaving,
		isError,
		lastSavedAt,
	} = useAutoSave({
		initialLastSavedAt: project.updated_at ?? new Date(),
		onSave,
	});

	useEffect(() => {
		const subscription = watch((values, { type }) => {
			if (type === "change" && values) {
				trigger().then((isValid) => {
					if (isValid) {
						dispatchAutoSave(values as TFormSchema);
					}
				});
			}
		});

		return () => subscription.unsubscribe();
	}, [watch, dispatchAutoSave, trigger]);

	return (
		<ProjectSettingsSection
			title={<Trans>Edit Project</Trans>}
			headerRight={
				<SaveStatus
					savedAt={lastSavedAt}
					formErrors={formState.errors}
					isPendingSave={isPendingSave}
					isSaving={isSaving}
					isError={isError}
				/>
			}
		>
			<form
				onSubmit={handleSubmit(async (values) => {
					await triggerManualSave(values);
				})}
			>
				<Stack gap="2rem">
					<Controller
						name="name"
						control={control}
						render={({ field }) => (
							<TextInput
								error={formState.errors.name?.message}
								label={
									<FormLabel
										label={t`Name`}
										isDirty={formState.dirtyFields.name}
										error={formState.errors.name?.message}
									/>
								}
								{...field}
								{...testId("project-settings-name-input")}
							/>
						)}
					/>

					<Controller
						name="context"
						control={control}
						render={({ field }) => (
							<Textarea
								error={formState.errors.context?.message}
								label={
									<FormLabel
										label={t`Context`}
										isDirty={formState.dirtyFields.context}
										error={formState.errors.context?.message}
									/>
								}
								rows={4}
								placeholder={t`How would you describe to a colleague what are you trying to accomplish with this project?
* What is the north star goal or key metric
* What does success look like`}
								{...field}
							/>
						)}
					/>
				</Stack>
			</form>
		</ProjectSettingsSection>
	);
};

export default ProjectBasicEdit;
