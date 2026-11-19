import {
	Controller,
	type ControllerProps,
	type FieldPath,
} from "react-hook-form";
import type { PortalFormValues } from "./portalForm";
import type { PortalPageForm } from "./usePortalPageForm";

/**
 * A field on a portal editor page: react-hook-form's Controller on the page's
 * form, whose every change saves itself after the field's own onChange (the
 * page's autosave). Not a watch() subscription, which React Compiler can't
 * compile.
 */
export const PortalController = <N extends FieldPath<PortalFormValues>>({
	page,
	render,
	...props
}: Omit<ControllerProps<PortalFormValues, N>, "control"> & {
	page: PortalPageForm;
}) => (
	<Controller
		{...props}
		control={page.form.control}
		render={(args) =>
			render({
				...args,
				field: {
					...args.field,
					onChange: (...event: unknown[]) => {
						args.field.onChange(...event);
						page.saveAfterChange();
					},
				},
			})
		}
	/>
);
