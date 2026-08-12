export interface UpdatesLabelInput {
	count: number;
	urgentTitle?: string | null;
}

export interface UpdatesLabelState {
	visible: boolean;
	urgent: boolean;
	title: string | null;
	count: number;
	/** Only set above 1: a lone update needs no number. */
	badge: number | undefined;
}

export function selectUpdatesLabel({
	count,
	urgentTitle,
}: UpdatesLabelInput): UpdatesLabelState {
	if (count <= 0) {
		return {
			badge: undefined,
			count: 0,
			title: null,
			urgent: false,
			visible: false,
		};
	}

	const trimmed = urgentTitle?.trim() ?? "";
	const urgent = trimmed.length > 0;

	return {
		badge: count > 1 ? count : undefined,
		count,
		title: urgent ? trimmed : null,
		urgent,
		visible: true,
	};
}
