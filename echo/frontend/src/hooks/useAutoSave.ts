import { useState } from "react";

const AUTOSAVE_DEBOUNCE_TIME = 1000;

export const useAutoSave = <T>({
	onSave,
	initialLastSavedAt,
}: {
	onSave: (data: T) => Promise<void>;
	initialLastSavedAt?: string | Date | undefined;
}) => {
	const [lastSavedAt, setLastSavedAt] = useState<Date>(
		initialLastSavedAt ? new Date(initialLastSavedAt) : new Date(),
	);
	const [autoSaveTimer, setAutoSaveTimer] = useState<NodeJS.Timeout | null>(
		null,
	);
	const [isPendingSave, setIsPendingSave] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isError, setIsError] = useState(false);

	const triggerSave = async (formData: T) => {
		setIsError(false);
		setIsSaving(true);

		try {
			await onSave(formData);
			setLastSavedAt(new Date());
			setIsPendingSave(false);
		} catch (e) {
			console.error("[useAutoSave] Save failed:", e);
			setIsError(true);
		} finally {
			setIsSaving(false);
		}
	};

	const dispatchAutoSave = (formData: T) => {
		clearTimeout(autoSaveTimer || undefined);
		setIsPendingSave(true);

		const timer = setTimeout(
			() => triggerSave(formData),
			AUTOSAVE_DEBOUNCE_TIME,
		);
		setAutoSaveTimer(timer);
	};

	const triggerManualSave = async (formData: T) => {
		clearTimeout(autoSaveTimer || undefined);
		setIsPendingSave(true);
		await triggerSave(formData);
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
