import { useCallback, useMemo, useState } from "react";

/**
 * Generic multi-select for a list of items keyed by id. Drives the bulk-move
 * selection on the conversations and projects overviews.
 *
 * Select-all semantics (founder spec): the header checkbox is checked only when
 * EVERY current item is selected; it shows indeterminate when some-but-not-all
 * are selected; clicking it while partial selects all (override), clicking it
 * while all-selected clears.
 *
 * `currentIds` is the set of ids currently visible/loaded — select-all and the
 * all/some flags are computed against it, and selection is pruned to it so ids
 * that scrolled out of a filtered list don't linger.
 */
export function useBulkSelection(currentIds: string[]) {
	const [selected, setSelected] = useState<Set<string>>(new Set());

	const currentSet = useMemo(() => new Set(currentIds), [currentIds]);

	// Only count selections that are still present in the current list.
	const selectedInView = useMemo(
		() => currentIds.filter((id) => selected.has(id)),
		[currentIds, selected],
	);
	const count = selectedInView.length;
	const allSelected = currentIds.length > 0 && count === currentIds.length;
	const someSelected = count > 0 && !allSelected;

	const isSelected = useCallback((id: string) => selected.has(id), [selected]);

	const toggle = useCallback((id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	// Click while not-all-selected → select all current; while all → clear.
	const toggleAll = useCallback(() => {
		setSelected((prev) => {
			const allNow =
				currentIds.length > 0 && currentIds.every((id) => prev.has(id));
			return allNow ? new Set() : new Set(currentIds);
		});
	}, [currentIds]);

	const clear = useCallback(() => setSelected(new Set()), []);

	return {
		/** Selected ids that are still in the current list (the move payload). */
		selectedIds: selectedInView,
		count,
		allSelected,
		someSelected,
		isSelected,
		toggle,
		toggleAll,
		clear,
		currentSet,
	};
}
