import {
	type NavigateOptions,
	type To,
	useNavigate,
	useParams,
} from "react-router";
import { stripLanguagePrefix } from "@/lib/language";
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

		if (
			isRelativePath(targetPath) ||
			targetPath === ".." ||
			targetPath === "."
		) {
			navigate(to, options);
			return;
		}

		// Strip any prefix already on the target and re-apply the active one, so a
		// stale prefix in ?next (e.g. /en-US/...) can't revert the UI after login.
		const languagePrefix = finalLanguage ? `/${finalLanguage}` : "";
		if (typeof to === "string") {
			navigate(`${languagePrefix}${stripLanguagePrefix(to)}`, options);
		} else {
			const nextTo = {
				...to,
				pathname: `${languagePrefix}${stripLanguagePrefix(to.pathname ?? "")}`,
			};
			navigate(nextTo, options);
		}
	};
}
