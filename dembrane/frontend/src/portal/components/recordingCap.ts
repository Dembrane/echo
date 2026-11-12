/** Portal mode resolution shared by the initiate form; text conversations never
 * count toward the concurrent recording meter. */

export const resolvePortalMode = (
	searchParams: URLSearchParams,
): "text" | "audio" => {
	const mode = searchParams.get("mode");
	if (mode === "text") return "text";
	if (mode === "audio") return "audio";
	return searchParams.get("general_feedback") || searchParams.get("feedback")
		? "text"
		: "audio";
};

/** A closed project shows no recorder, unless this conversation already has audio. */
export const recordingClosed = (state: {
	takingRecordings: boolean | undefined;
	chunkCount: number | undefined;
	recordingStarted: boolean;
}): boolean =>
	state.takingRecordings === false &&
	state.chunkCount === 0 &&
	!state.recordingStarted;
