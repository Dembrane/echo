import { useLingui } from "@lingui/react";
import { Box, LoadingOverlay } from "@mantine/core";
import { type PropsWithChildren, useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { readStoredLanguage } from "@/lib/language";
import { type CatalogModule, createCatalogHook } from "@/lib/lazyCatalog";

/** The accounts screens' own catalog (./locales), off the portal's first load. */
export const useAccountsCatalog = createCatalogHook(
	import.meta.glob<CatalogModule>("./locales/*.ts"),
);

/**
 * Signing is offered in the two languages its documents are written in. Any other
 * interface language reads the signing screens in English.
 */
const SIGNING_LOCALES = new Set(["en-US", "nl-NL"]);
export const signingLocale = (locale: string): string =>
	SIGNING_LOCALES.has(locale) ? locale : "en-US";

/**
 * The language prefix of the address (`/de-DE/o/...`) decides the app's language, so a
 * signing address in another language moves to its English twin and the app follows. The
 * language the person chose in the picker is not touched.
 */
function SigningLanguage({ children }: PropsWithChildren) {
	const { language } = useParams<{ language?: string }>();
	const { i18n } = useLingui();
	const location = useLocation();
	const navigate = useNavigate();
	const current = language ?? readStoredLanguage() ?? i18n.locale;
	const target = signingLocale(current);
	const redirecting = current !== target;
	useEffect(() => {
		if (!redirecting) return;
		const rest = language
			? location.pathname.replace(new RegExp(`^/${language}(?=/|$)`), "")
			: location.pathname;
		navigate(`/${target}${rest}${location.search}${location.hash}`, {
			replace: true,
		});
	}, [redirecting, language, target, location, navigate]);
	if (redirecting) return <Loading />;
	return <>{children}</>;
}

const Loading = () => (
	<Box pos="relative" h={240}>
		<LoadingOverlay visible />
	</Box>
);

/**
 * Wraps the accounts screens in their catalog. `signing` marks the signing screens, which
 * speak English or Dutch only (see signingLocale).
 */
export const AccountsI18n = ({
	children,
	signing = false,
}: PropsWithChildren<{ signing?: boolean }>) => {
	const ready = useAccountsCatalog();
	if (!ready) return <Loading />;
	return signing ? (
		<SigningLanguage>{children}</SigningLanguage>
	) : (
		<>{children}</>
	);
};
