import { Skeleton, Stack } from "@mantine/core";
import type { ComponentProps } from "react";
import { useTemplatesCatalog } from "../i18n";
import { useProjectTemplates } from "../projectTemplates";
import { TemplatePicker } from "./TemplatePicker";

type Props = Omit<
	ComponentProps<typeof TemplatePicker>,
	"templates" | "failed"
> & {
	/** The new project's language: the participant-facing words come in it. */
	language: string;
};

/** TemplatePicker with the templates fetched and its catalog loaded. */
export const TemplatePickerConnected = ({ language, ...props }: Props) => {
	const ready = useTemplatesCatalog();
	const { data, isError } = useProjectTemplates(language);
	if (!ready)
		return (
			<Stack gap="sm" aria-busy="true">
				<Skeleton height={28} w={280} />
				<Skeleton height={132} />
			</Stack>
		);
	return <TemplatePicker {...props} templates={data} failed={isError} />;
};

export default TemplatePickerConnected;
