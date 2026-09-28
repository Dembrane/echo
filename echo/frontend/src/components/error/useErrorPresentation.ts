import { useLingui } from "@lingui/react";
import { useEffect, useState } from "react";
import {
	loadErrorMessages,
	type PresentedError,
	presentErrorNow,
} from "@/lib/errors/present";

/**
 * The presented form of `error` (null when there is none), re-rendered once the message
 * chunk for the current language has loaded.
 */
export function useErrorPresentation(error: unknown): PresentedError | null {
	const { i18n } = useLingui();
	const [, setLoadedFor] = useState<string | null>(null);
	useEffect(() => {
		if (!error) return;
		let live = true;
		loadErrorMessages(i18n).then(() => {
			if (live) setLoadedFor(i18n.locale);
		});
		return () => {
			live = false;
		};
	}, [error, i18n]);
	// Cheap to compute; the state above re-renders once the messages arrive.
	return error ? presentErrorNow(error, i18n) : null;
}
