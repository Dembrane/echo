import { useLingui } from "@lingui/react";
import { useEffect, useState } from "react";
import {
	loadErrorMessages,
	type PresentedError,
	presentErrorNow,
} from "@/lib/errors/present";

/**
 * The presented form of `error` (null when there is none): the action's fallback at once,
 * then the specific message once the message chunk for the current language has loaded.
 * The loaded presentation is kept in state, not recomputed from (error, i18n), because
 * the React compiler memoizes on those inputs and would never see the chunk arrive.
 */
export function useErrorPresentation(error: unknown): PresentedError | null {
	const { i18n } = useLingui();
	const [loaded, setLoaded] = useState<{
		error: unknown;
		locale: string;
		presented: PresentedError;
	} | null>(null);
	useEffect(() => {
		if (!error) return;
		let live = true;
		loadErrorMessages(i18n).then(() => {
			if (live)
				setLoaded({
					error,
					locale: i18n.locale,
					presented: presentErrorNow(error, i18n),
				});
		});
		return () => {
			live = false;
		};
	}, [error, i18n, i18n.locale]);
	if (!error) return null;
	if (loaded && loaded.error === error && loaded.locale === i18n.locale)
		return loaded.presented;
	return presentErrorNow(error, i18n);
}
