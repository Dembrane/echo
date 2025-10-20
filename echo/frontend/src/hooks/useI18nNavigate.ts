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

		const isString = to.toString();

		// Check if 'to' starts with any supported language prefix
		const hasLanguagePrefix = SUPPORTED_LANGUAGES.some((lang) =>
			isString.startsWith(`/${lang}`),
		);

		if (hasLanguagePrefix) {
			navigate(to, options);
		} else {
			// Add the language prefix if it's not already present
			const languagePrefix = finalLanguage ? `/${finalLanguage}` : "";
			navigate(`${languagePrefix}${to}`, options);
		}
	};
}
