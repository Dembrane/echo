import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Group,
	NativeSelect,
	Paper,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { IconCircleCheck } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { LibraryTemplatesMenu } from "@/components/library/LibraryTemplatesMenu";
import { useLanguage } from "@/hooks/useLanguage";
import { CloseableAlert } from "../common/ClosableAlert";
import { languageOptionsByIso639_1 } from "../language/LanguagePicker";
import { useGenerateProjectViewMutation } from "./hooks";

type CreateViewForm = {
	query: string;
	additionalContext: string;
	language: string;
};

export const CreateView = ({
	projectId,
	initialQuery,
	initialAdditionalContext,
}: {
	projectId: string;
	initialQuery?: string;
	initialAdditionalContext?: string;
}) => {
	const createViewMutation = useGenerateProjectViewMutation();

	const { iso639_1 } = useLanguage();

	const { register, handleSubmit, reset, setValue, watch } =
		useForm<CreateViewForm>({
			defaultValues: {
				additionalContext: initialAdditionalContext || "",
				language: iso639_1,
				query: initialQuery || "",
			},
		});

	const queryValue = watch("query");
	const additionalContextValue = watch("additionalContext");

	const [pendingTemplate, setPendingTemplate] = useState<{
		query: string;
		additionalContext: string;
	} | null>(null);

	const onSubmit = (data: CreateViewForm) => {
		createViewMutation.mutate({
			additionalContext: data.additionalContext,
			language: data.language || iso639_1,
			projectId,
			query: data.query,
		});
	};

	useEffect(() => {
		if (createViewMutation.isSuccess) {
			reset();
		}
	}, [createViewMutation.isSuccess, reset]);

	const handleTemplateSelect = ({
		query,
		additionalContext,
	}: {
		query: string;
		additionalContext: string;
	}) => {
		if (queryValue?.trim() !== "" || additionalContextValue?.trim() !== "") {
			setPendingTemplate({ additionalContext, query });
			return;
		}

		setValue("query", query);
		setValue("additionalContext", additionalContext);
	};

	return (
		<Paper className="max-w-[800px] border-none" py="sm">
			<Stack>
				<form>
					<Stack gap="lg">
						{createViewMutation.isError && (
							<Alert variant="filled" color="red">
								{createViewMutation.error?.message}
							</Alert>
						)}
						{createViewMutation.isSuccess && (
							<CloseableAlert
								variant="light"
								color="green"
								icon={<IconCircleCheck />}
							>
								<Text>
									<Trans>
										Your view has been created. Please wait as we process and
										analyse the data.
									</Trans>
								</Text>
							</CloseableAlert>
						)}
						<NativeSelect
							{...register("language")}
							label={t`Analysis Language`}
							data={languageOptionsByIso639_1}
						/>

						<LibraryTemplatesMenu onTemplateSelect={handleTemplateSelect} />

						<TextInput
							{...register("query")}
							label={t`Enter your query`}
							required
							placeholder={t`Topics`}
						/>
						<Textarea
							rows={5}
							{...register("additionalContext")}
							label={t`Add additional context (Optional)`}
							placeholder={t`Give me a list of 5-10 topics that are being discussed.`}
						/>
						<Group className="w-full" justify="flex-end">
							<Button
								onClick={handleSubmit(onSubmit)}
								loading={createViewMutation.isPending}
								disabled={createViewMutation.isPending}
							>
								<Trans>Create View</Trans>
							</Button>
						</Group>
					</Stack>
				</form>

				<ConfirmModal
					opened={!!pendingTemplate}
					onClose={() => setPendingTemplate(null)}
					title={t`Apply template`}
					data-testid="view-apply-template-modal"
					message={t`This will clear your current input. Are you sure?`}
					confirmLabel={<Trans>Apply</Trans>}
					onConfirm={() => {
						if (pendingTemplate) {
							setValue("query", pendingTemplate.query);
							setValue("additionalContext", pendingTemplate.additionalContext);
							setPendingTemplate(null);
						}
					}}
				/>
			</Stack>
		</Paper>
	);
};
