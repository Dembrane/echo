import {
	type NavigateOptions,
	type To,
	useNavigate,
	useParams,
} from "react-router";
import { SUPPORTED_LANGUAGES } from "@/config";
import { useLanguage } from "./useLanguage";

export function useI18nNavigate() {
	const navigate = useNavigate();
	const { language } = useParams<{ language?: string }>();
	const { language: i18nLanguage } = useLanguage();

	const finalLanguage = language ?? i18nLanguage;

	return (to: To, options?: NavigateOptions) => {
		if (typeof to === "number") {
			navigate(to, options);
			return;
		}

		const targetPath =
			typeof to === "string"
				? to
				: typeof to === "object" && to !== null && "pathname" in to
					? (to.pathname as string | undefined)
					: undefined;

		const isRelativePath = (value?: string) =>
			!!value && (value.startsWith("../") || value.startsWith("./"));

		if (isRelativePath(targetPath) || targetPath === ".." || targetPath === ".") {
			navigate(to, options);
			return;
		}

		// Check if 'to' starts with any supported language prefix
		const pathToCheck = targetPath ?? to.toString();
		const hasLanguagePrefix = SUPPORTED_LANGUAGES.some((lang) =>
			pathToCheck.startsWith(`/${lang}`),
		);

		if (hasLanguagePrefix) {
			navigate(to, options);
		} else {
			// Add the language prefix if it's not already present
			const languagePrefix = finalLanguage ? `/${finalLanguage}` : "";
			if (typeof to === "string") {
				navigate(`${languagePrefix}${to}`, options);
			} else {
				const nextTo = {
					...to,
					pathname: `${languagePrefix}${to.pathname ?? ""}`,
				};
				navigate(nextTo, options);
			}
		}
	};
}
