import type { MessageDescriptor } from "@lingui/core";
import type { ErrorCode, UserErrorCode } from "../catalog/index.gen";

/**
 * One namespace's friendly messages. Every code a person can see ("user" audience) needs
 * one, so a new code without a message fails `tsc`; staff and developer codes may have one.
 * Placeholders are the code's params in ICU form: "Files can be at most {max_mb} MB."
 */
export type Messages<N extends string> = {
	readonly [C in Extract<UserErrorCode, `${N}.${string}`>]: MessageDescriptor;
} & {
	readonly [C in Exclude<
		Extract<ErrorCode, `${N}.${string}`>,
		UserErrorCode
	>]?: MessageDescriptor;
};
