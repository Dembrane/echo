import { t } from "@lingui/core/macro";
import { format } from "date-fns";

export type CanvasCadenceSource = {
	cadence_minutes?: number | null;
	expires_at?: string | null;
};

export function canvasCadenceLabel(source: CanvasCadenceSource): string {
	const cadenceMinutes = source.cadence_minutes ?? null;
	if (!cadenceMinutes || cadenceMinutes <= 0) {
		return t`Does not update on its own.`;
	}

	if (!source.expires_at) {
		return t`Updates every ${cadenceMinutes} minutes.`;
	}

	const expiry = new Date(source.expires_at);
	if (Number.isNaN(expiry.getTime())) {
		return t`Updates every ${cadenceMinutes} minutes.`;
	}

	return t`Updates every ${cadenceMinutes} minutes until ${format(expiry, "PPp")}.`;
}
