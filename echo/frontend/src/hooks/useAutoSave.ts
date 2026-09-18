import { useEffect, useRef, useState } from "react";

const AUTOSAVE_DEBOUNCE_TIME = 1000;

export const useAutoSave = <T>({
	onSave,
	initialLastSavedAt,
}: {
	onSave: (data: T) => Promise<void>;
	initialLastSavedAt?: string | Date | undefined;
}) => {
	const generation = useRef(0);
	const inFlight = useRef(0);
	const [lastSavedAt, setLastSavedAt] = useState<Date>(
		initialLastSavedAt ? new Date(initialLastSavedAt) : new Date(),
	);
	const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const owed = useRef<{ data: T } | null>(null);
	const latestOnSave = useRef(onSave);
	latestOnSave.current = onSave;
	const [isPendingSave, setIsPendingSave] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isError, setIsError] = useState(false);

	const triggerSave = async (formData: T, version: number) => {
		inFlight.current += 1;
		setIsError(false);
		setIsSaving(true);

		try {
			await onSave(formData);
			setLastSavedAt(new Date());
			if (version === generation.current) setIsPendingSave(false);
			return true;
		} catch (e) {
			console.error("[useAutoSave] Save failed:", e);
			setIsError(true);
			return false;
		} finally {
			inFlight.current -= 1;
			setIsSaving(inFlight.current > 0);
		}
	};

	const dispatchAutoSave = (formData: T) => {
		const version = ++generation.current;
		clearTimeout(autoSaveTimer.current || undefined);
		setIsPendingSave(true);

		owed.current = { data: formData };
		const timer = setTimeout(() => {
			owed.current = null;
			void triggerSave(formData, version);
		}, AUTOSAVE_DEBOUNCE_TIME);
		autoSaveTimer.current = timer;
	};

	// A field that unmounts inside its debounce saves now, not a second later:
	// a Publish or a navigation right after the edit then sees it.
	useEffect(
		() => () => {
			clearTimeout(autoSaveTimer.current || undefined);
			const pending = owed.current;
			owed.current = null;
			if (pending) {
				latestOnSave.current(pending.data).catch((e) => {
					console.error("[useAutoSave] Save on unmount failed:", e);
				});
			}
		},
		[],
	);

	const triggerManualSave = async (formData: T) => {
		clearTimeout(autoSaveTimer.current || undefined);
		owed.current = null;
		setIsPendingSave(true);
		return await triggerSave(formData, ++generation.current);
	};

	return {
		dispatchAutoSave,
		isError,
		isPendingSave,
		isSaving,
		lastSavedAt,
		triggerManualSave,
	};
};
