import { I18nProvider as I18nP } from "@lingui/react";
import type { PropsWithChildren } from "react";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { useLanguage } from "@/hooks/useLanguage";

export const I18nProvider = ({ children }: PropsWithChildren) => {
	const { i18n, loading } = useLanguage();

	if (loading) {
		return <BeautifulLoading className="min-h-dvh" />;
	}

	return <I18nP i18n={i18n}>{children}</I18nP>;
};
