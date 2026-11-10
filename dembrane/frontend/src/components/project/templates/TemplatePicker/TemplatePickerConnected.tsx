import type { ComponentProps } from "react";
import { useProjectTemplates } from "../projectTemplates";
import { TemplatePicker } from "./TemplatePicker";

type Props = Omit<
	ComponentProps<typeof TemplatePicker>,
	"templates" | "failed"
>;

/** TemplatePicker with the templates fetched. */
export const TemplatePickerConnected = (props: Props) => {
	const { data, isError } = useProjectTemplates();
	return <TemplatePicker {...props} templates={data} failed={isError} />;
};
