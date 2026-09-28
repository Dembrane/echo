import type { I18n } from "@lingui/core";
import { presentError } from "@/lib/errors/present";

/**
 * Puts a validation error's field messages next to their inputs. `setError` is
 * react-hook-form's (or any function of the same shape); `fieldFor` maps the API's field
 * path to the form's name when they differ. Returns true when at least one field was set,
 * so the caller shows a general notice only for errors that are not about a field.
 */
export async function applyFieldErrors(
	error: unknown,
	i18n: I18n,
	setError: (name: string, error: { type: string; message: string }) => void,
	fieldFor: (apiField: string) => string | null = (f) => f,
): Promise<boolean> {
	const presented = await presentError(error, i18n);
	let set = false;
	for (const [apiField, message] of Object.entries(presented.fields)) {
		const name = fieldFor(apiField);
		if (!name) continue;
		setError(name, { message, type: "server" });
		set = true;
	}
	return set;
}
