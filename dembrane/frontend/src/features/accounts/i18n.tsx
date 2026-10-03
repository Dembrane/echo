import { useLingui } from "@lingui/react";
import { Box, LoadingOverlay } from "@mantine/core";
import { type PropsWithChildren, useEffect, useState } from "react";

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

export const AccountsI18n = ({ children }: PropsWithChildren) => {
	const ready = useAccountsCatalog();
	if (!ready) {
		return (
			<Box pos="relative" h={240}>
				<LoadingOverlay visible />
			</Box>
		);
	}
	return <>{children}</>;
};
