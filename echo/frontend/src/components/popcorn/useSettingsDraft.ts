import { useEffect, useMemo, useRef, useState } from "react";
import { useSettingsFlush } from "@/components/popcorn/SettingsSaveContext";
import { useAutoSave } from "@/hooks/useAutoSave";

// One editable draft of a settings form, reconciled against the server copy.
// Every field on these forms autosaves: a change is dirty at once, saved a
// debounce later, and flushed early when Present publishes. The server copy
// keeps arriving from refetches while those saves are in flight, so the draft
// the host is typing into is only replaced when there is nothing to protect.
//
// `identity` is the form this draft belongs to (project, popcorn, section).
// When it changes the form is showing something else, so the server copy wins.
// `save` receives the whole draft and sends whatever patch this form owns; it
// may throw to refuse a draft (an empty required title), which leaves the
// draft dirty and shows the error in SaveStatus.
//
// The debounce, the save state and the save-on-unmount all come from
// useAutoSave. This hook adds no unmount save of its own, so a field that
// unmounts inside its debounce still saves exactly once.
export function useSettingsDraft<T>({
	flushErrorMessage,
	identity,
	initialLastSavedAt,
	save,
	serverValue,
}: {
	serverValue: T;
	identity: string;
	save: (next: T) => Promise<void>;
	initialLastSavedAt?: string | Date | undefined;
	flushErrorMessage: string;
}) {
	// The server copy is a fresh object on every render. Its JSON is what the
	// reconciler compares on, so a refetch that changed nothing stays quiet.
	const serverKey = JSON.stringify(serverValue);
	const serverDraft = useMemo<T>(() => JSON.parse(serverKey), [serverKey]);
	const [draft, setDraft] = useState<T>(serverDraft);
	const currentRef = useRef(draft);
	const dirtyRef = useRef(false);
	const identityRef = useRef(identity);

	const onSave = async (next: T) => {
		const savedDraft = JSON.stringify(next);
		await save(next);
		// A response for an older draft must not make a newer keystroke clean.
		if (JSON.stringify(currentRef.current) === savedDraft) {
			dirtyRef.current = false;
		}
	};
	const {
		dispatchAutoSave,
		isError,
		isPendingSave,
		isSaving,
		lastSavedAt,
		triggerManualSave,
	} = useAutoSave<T>({ initialLastSavedAt, onSave });

	useSettingsFlush(async () => {
		if (!dirtyRef.current && !isPendingSave) return;
		const saved = await triggerManualSave(currentRef.current);
		if (!saved) throw new Error(flushErrorMessage);
	}, isPendingSave || isSaving);

	// Refetches can arrive while an older autosave is in flight. Adopt server
	// changes only when this form has no newer local draft to protect.
	useEffect(() => {
		if (identityRef.current !== identity) {
			identityRef.current = identity;
			currentRef.current = serverDraft;
			dirtyRef.current = false;
			setDraft(serverDraft);
			return;
		}
		if (!dirtyRef.current && JSON.stringify(currentRef.current) !== serverKey) {
			currentRef.current = serverDraft;
			setDraft(serverDraft);
		}
	}, [identity, serverDraft, serverKey]);

	const changeDraft = (next: T) => {
		currentRef.current = next;
		dirtyRef.current = true;
		setDraft(next);
		dispatchAutoSave(next);
	};

	return {
		changeDraft,
		draft,
		isError,
		isPendingSave,
		isSaving,
		lastSavedAt,
	};
}
