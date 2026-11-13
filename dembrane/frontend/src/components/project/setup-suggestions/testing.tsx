import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";

/** The providers every block test renders inside. */
export const Providers = ({ children }: { children: ReactNode }) => (
	<I18nProvider i18n={i18n}>
		<MantineProvider>{children}</MantineProvider>
	</I18nProvider>
);

export function setUpDom() {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia ||= ((query: string) =>
		({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}) as unknown as MediaQueryList) as typeof window.matchMedia;
}
