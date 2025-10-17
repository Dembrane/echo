import { zodResolver } from "@hookform/resolvers/zod";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Group, Stack, Text } from "@mantine/core";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { useAutoSave } from "@/hooks/useAutoSave";
import { FormLabel } from "../form/FormLabel";
import { MarkdownWYSIWYG } from "../form/MarkdownWYSIWYG/MarkdownWYSIWYG";
import { SaveStatus } from "../form/SaveStatus";
import { useUpdateProjectReportMutation } from "./hooks";

const FormSchema = z.object({
	content: z.string(),
	show_portal_link: z.boolean(),
});

type ReportEditorFormValues = z.infer<typeof FormSchema>;

// Memoized MarkdownWYSIWYG wrapper
const MemoizedMarkdownWYSIWYG = memo(MarkdownWYSIWYG);

const ReportEditorComponent: React.FC<{
	report: ProjectReport;
	onSaveSuccess?: () => void;
}> = ({ report, onSaveSuccess }) => {
	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be fixed
	const defaultValues = useMemo(() => {
		return {
			content: report.content ?? "",
			show_portal_link: report.show_portal_link ?? true,
		};
	}, [report.id]);

	const formResolver = useMemo(() => zodResolver(FormSchema), []);

	const { control, handleSubmit, watch, formState, reset } =
		useForm<ReportEditorFormValues>({
			defaultValues,
			mode: "onChange",
			resolver: formResolver,
			reValidateMode: "onChange",
		});

	const updateReportMutation = useUpdateProjectReportMutation();

	const onSave = useCallback(
		async (values: ReportEditorFormValues) => {
			const projectId =
				typeof report.project_id === "object" && report.project_id?.id
					? report.project_id.id
					: report.project_id;

			await updateReportMutation.mutateAsync({
				payload: {
					...values,
					project_id: { id: projectId } as Project,
				},
				reportId: report.id,
			});

			// Reset the form with the current values to clear the dirty state
			reset(values, { keepDirty: false, keepValues: true });
			onSaveSuccess?.();
		},
		[report.id, report.project_id, updateReportMutation, reset, onSaveSuccess],
	);

	const {
		dispatchAutoSave,
		triggerManualSave,
		isPendingSave,
		isSaving,
		isError,
		lastSavedAt,
	} = useAutoSave({
		initialLastSavedAt: report.date_updated
			? new Date(report.date_updated)
			: new Date(),
		onSave,
	});

	// Create a stable reference to dispatchAutoSave
	const dispatchAutoSaveRef = useRef(dispatchAutoSave);
	useEffect(() => {
		dispatchAutoSaveRef.current = dispatchAutoSave;
	}, [dispatchAutoSave]);

	useEffect(() => {
		const subscription = watch((values, { type }) => {
			if (type === "change" && values) {
				dispatchAutoSaveRef.current(values as ReportEditorFormValues);
			}
		});

		return () => {
			subscription.unsubscribe();
		};
	}, [watch]);

	return (
		<Box>
			<form
				onSubmit={handleSubmit(async (values) => {
					await triggerManualSave(values);
				})}
			>
				<Stack gap="2rem">
					<Stack gap="sm">
						<Group>
							<FormLabel
								label={t`Edit Report Content`}
								isDirty={formState.dirtyFields.content}
								error={formState.errors.content?.message}
							/>
							<SaveStatus
								formErrors={formState.errors}
								savedAt={lastSavedAt}
								isPendingSave={isPendingSave}
								isSaving={isSaving}
								isError={isError}
							/>
						</Group>
						<Text size="sm" c="dimmed">
							<Trans id="report.editor.description">
								Edit the report content using the rich text editor below. You
								can format text, add links, images, and more.
							</Trans>
						</Text>
						<Controller
							name="content"
							control={control}
							render={({ field }) => (
								<MemoizedMarkdownWYSIWYG
									markdown={field.value}
									onChange={field.onChange}
								/>
							)}
						/>
					</Stack>
				</Stack>
			</form>
		</Box>
	);
};

// Memoize the component to prevent re-renders when report hasn't changed
export const ReportEditor = memo(
	ReportEditorComponent,
	(prevProps, nextProps) => {
		// Only re-render if the report ID has changed
		return prevProps.report.id === nextProps.report.id;
	},
);
