import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import {
	formatResetDay,
	freeLimitDetails,
	isFreeTierLimitError,
} from "./freeTier";
import { formatDuration } from "./time";

// The server allows this much over the per-file limit.
const FILE_TOLERANCE_SECONDS = 1;

export type PrecheckRefusal = {
	name: string;
	seconds: number;
	reason: "file_too_long" | "over_remaining";
	limitSeconds: number;
};

// Refuses only files the browser knows are too long; unknown lengths go to the server.
export function precheckUploads(
	files: readonly { name: string; seconds: number | null }[],
	status: { fileLimitSeconds: number | null; secondsLeft: number | null },
): PrecheckRefusal[] {
	const refusals: PrecheckRefusal[] = [];
	let left = status.secondsLeft;
	for (const { name, seconds } of files) {
		if (seconds == null || !Number.isFinite(seconds)) continue;
		const fileLimit = status.fileLimitSeconds;
		if (fileLimit != null && seconds > fileLimit + FILE_TOLERANCE_SECONDS) {
			refusals.push({
				limitSeconds: fileLimit,
				name,
				reason: "file_too_long",
				seconds,
			});
			continue;
		}
		if (left == null) continue;
		const charge = Math.round(seconds);
		if (charge > left) {
			refusals.push({
				limitSeconds: left,
				name,
				reason: "over_remaining",
				seconds,
			});
			continue;
		}
		left -= charge;
	}
	return refusals;
}

// Seconds under an hour, minutes above; to the second when asked.
const length = (seconds: number, toSecond = false) =>
	formatDuration(seconds, toSecond ? "exact" : "second");

const lengths = (a: number, b: number): [string, string] => {
	const pair: [string, string] = [length(a), length(b)];
	return pair[0] === pair[1] ? [length(a, true), length(b, true)] : pair;
};

const overRemaining = (fileSeconds: number, leftSeconds: number) => {
	const [file, left] = lengths(fileSeconds, leftSeconds);
	return t`This file is ${file} long. You have ${left} of recording left this month.`;
};

const tooLong = (fileSeconds: number, limitSeconds: number) => {
	const [file, limit] = lengths(fileSeconds, limitSeconds);
	return t`This file is ${file} long. Files can be at most ${limit} long on the free plan.`;
};

export function precheckRefusalMessage(refusal: PrecheckRefusal): string {
	return refusal.reason === "file_too_long"
		? tooLong(refusal.seconds, refusal.limitSeconds)
		: overRemaining(refusal.seconds, refusal.limitSeconds);
}

const num = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

// The words for a free-limit upload refusal from the server, or null for any other error.
// `resetsAt` is the allowance's reset: the AI budget refusal carries no date.
export function uploadRefusalMessage(
	err: unknown,
	resetsAt?: string | null,
): string | null {
	const limit = isFreeTierLimitError(err);
	if (limit === "ai_budget") {
		const date = formatResetDay(resetsAt, i18n.locale);
		return date
			? t`This month's AI is used up. New recordings and uploads are paused until ${date}.`
			: t`This month's AI is used up. New recordings and uploads are paused until next month.`;
	}
	if (limit === "recording_project")
		return t`This project is not the one taking recordings on the free plan.`;
	if (limit !== "audio_month" && limit !== "audio_conversation") return null;
	const details = freeLimitDetails(err) ?? {};
	const fileSeconds = num(details.file_seconds);
	if (limit === "audio_month") {
		const remaining = num(details.remaining_seconds);
		if (fileSeconds != null && remaining != null)
			return overRemaining(fileSeconds, remaining);
		return t`You have no recording left this month.`;
	}
	const limitSeconds = num(details.limit_seconds);
	if (limitSeconds == null) return null;
	if (fileSeconds != null) return tooLong(fileSeconds, limitSeconds);
	const max = length(limitSeconds);
	return t`Files can be at most ${max} long on the free plan.`;
}
