import { createContext, useContext, useEffect, useId, useRef } from "react";
import type { PopcornDetail, PopcornSettingsPatch } from "./hooks";

export type SettingsSaveOverride = {
	save: (patch: PopcornSettingsPatch) => Promise<PopcornDetail>;
	registerFlush: (flush: () => Promise<void>) => () => void;
	setFieldPending: (id: string, pending: boolean) => void;
};

// The same settings fields edit live legacy Popcorn or a Present draft.
export const SettingsSaveContext = createContext<SettingsSaveOverride | null>(
	null,
);

export function useSettingsFlush(flush: () => Promise<void>, pending = false) {
	const context = useContext(SettingsSaveContext);
	const id = useId();
	const latest = useRef(flush);
	latest.current = flush;
	useEffect(
		() => context?.registerFlush(() => latest.current()),
		[context?.registerFlush],
	);
	useEffect(() => {
		context?.setFieldPending(id, pending);
		return () => context?.setFieldPending(id, false);
	}, [context?.setFieldPending, id, pending]);
}
