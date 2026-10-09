export type ParticipantState =
	| "finishing"
	| "backgrounded"
	| "verifying"
	| "refining"
	| "recording"
	| "paused"
	| "waiting";

/**
 * What the participant is doing right now, as the host monitor shows it:
 * recording / paused / verifying / backgrounded / just waiting between audio
 * chunks. The first matching state wins.
 */
export const deriveParticipantState = (screen: {
	isStopping: boolean;
	isRecording: boolean;
	isPaused: boolean;
	documentHidden: boolean;
	isOnVerifyRoute: boolean;
	isOnRefineRoute: boolean;
}): ParticipantState => {
	if (screen.isStopping) return "finishing";
	if (screen.documentHidden && screen.isRecording) return "backgrounded";
	if (screen.isOnVerifyRoute) return "verifying";
	if (screen.isOnRefineRoute) return "refining";
	if (screen.isRecording) return "recording";
	if (screen.isPaused) return "paused";
	return "waiting";
};
