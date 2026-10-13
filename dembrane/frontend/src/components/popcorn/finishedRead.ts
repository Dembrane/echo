import { plural, t } from "@lingui/core/macro";
import type { PopcornLoop } from "@/components/popcorn/hooks";

// The conversations whose finish caused the last read, as the status says it.
// Null when a host's press or the live chain caused the last read.
export function readAfterFinish(loop: PopcornLoop | null | undefined) {
	const after = loop?.last_read_after;
	if (!after?.length) return null;
	const name = after.length === 1 ? after[0]?.name : null;
	if (name) return t`Read after ${name} finished`;
	return plural(after.length, {
		one: "Read after a conversation finished",
		other: "Read after # conversations finished",
	});
}
