/**
 * What the portal's one button after recording leads to (ECHO-1052): Verify alone, Explore
 * alone, a choice between both, or nothing when neither is on.
 */
export type RefineMode = "verify" | "explore" | "both";

export const refineMode = (
	project:
		| {
				is_verify_enabled?: boolean | null;
				is_get_reply_enabled?: boolean | null;
		  }
		| null
		| undefined,
): RefineMode | null => {
	const verify = !!project?.is_verify_enabled;
	const explore = !!project?.is_get_reply_enabled;
	if (verify && explore) return "both";
	if (verify) return "verify";
	if (explore) return "explore";
	return null;
};
