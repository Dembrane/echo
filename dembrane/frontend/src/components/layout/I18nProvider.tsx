import { I18nProvider as I18nP } from "@lingui/react";
import { LoadingOverlay } from "@mantine/core";
import type { PropsWithChildren } from "react";
import { useLanguage } from "@/hooks/useLanguage";

export const I18nProvider = ({ children }: PropsWithChildren) => {
	const { i18n, loading } = useLanguage();

	if (loading) {
		return <LoadingOverlay visible />;
	}

	return <I18nP i18n={i18n}>{children}</I18nP>;
};
