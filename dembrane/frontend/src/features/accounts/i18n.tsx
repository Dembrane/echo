import { useLingui } from "@lingui/react";
import { Box, LoadingOverlay } from "@mantine/core";
import { type PropsWithChildren, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { readStoredLanguage } from "@/lib/language";

/**
 * The accounts screens carry their own lingui catalog (src/features/accounts/locales),
 * loaded when one of them opens. The main catalogs are bundled into the first load of
 * the dashboard and the participant portal, so strings kept here cost the portal nothing.
 * `pnpm messages:extract` and `messages:compile` write both catalogs.
 */
const catalogs = import.meta.glob<{ messages: Record<string, string> }>(
	"./locales/*.ts",
);
const loaded = new Set<string>();

async function loadCatalog(
	i18n: ReturnType<typeof useLingui>["i18n"],
	locale: string,
) {
	if (loaded.has(locale)) return;
	const loader =
		catalogs[`./locales/${locale}.ts`] ?? catalogs["./locales/en-US.ts"];
	if (!loader) return;
	const { messages } = await loader();
	i18n.load(locale, messages);
	loaded.add(locale);
}

/** Loads the accounts catalog for the current locale; true once its strings are in. */
export function useAccountsCatalog(): boolean {
	const { i18n } = useLingui();
	const locale = i18n.locale;
	const [ready, setReady] = useState(loaded.has(locale));
	useEffect(() => {
		let live = true;
		if (loaded.has(locale)) {
			setReady(true);
			return;
		}
		setReady(false);
		loadCatalog(i18n, locale).finally(() => {
			if (live) setReady(true);
		});
		return () => {
			live = false;
		};
	}, [i18n, locale]);
	return ready;
}

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
