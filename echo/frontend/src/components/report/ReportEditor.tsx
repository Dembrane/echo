import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useEffect, useCallback, useMemo, useRef, memo } from "react";
import { Group, Stack, Box, Text } from "@mantine/core";
import { MarkdownWYSIWYG } from "../form/MarkdownWYSIWYG/MarkdownWYSIWYG";
import { FormLabel } from "../form/FormLabel";
import { useForm, Controller, useWatch } from "react-hook-form";
import { useAutoSave } from "@/hooks/useAutoSave";
import { SaveStatus } from "../form/SaveStatus";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
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
      resolver: formResolver,
      mode: "onChange",
      reValidateMode: "onChange",
    });

  const updateReportMutation = useUpdateProjectReportMutation();

  const onSave = useCallback(
    async (values: ReportEditorFormValues) => {
      const projectId =
        typeof report.project_id === "object" && report.project_id?.id
          ? report.project_id.id
          : report.project_id;

      const data = await updateReportMutation.mutateAsync({
        reportId: report.id,
        payload: {
          ...values,
          project_id: { id: projectId } as Project,
        },
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
    onSave,
    initialLastSavedAt: report.date_updated
      ? new Date(report.date_updated)
      : new Date(),
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
