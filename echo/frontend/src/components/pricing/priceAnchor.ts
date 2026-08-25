import posthog from "posthog-js";
import { useEffect, useState } from "react";

/** The price anchor feature flag.
 *
 * The question it settles: whether the opening step reads better with no
 * number at all, or with a starting price. That is not something anybody can
 * reason out, so it ships behind a flag and the booking rate answers it.
 *
 * It is a FLAG, never a constant. The rest of the configurator carries no
 * price on purpose, so a hard coded number here would quietly reverse a
 * decision the whole flow rests on. Only the flag may turn it on, and only
 * for the share of people the flag holds.
 *
 * Nothing else in this frontend reads a feature flag yet, so there is no house
 * pattern to follow. This uses posthog-js directly, which is how the app
 * already reaches PostHog everywhere else (`posthog.capture` in fifteen
 * files), with a safe default at every step.
 */

/** The flag in PostHog. Two variants, and only one of them draws anything.
 * The line it draws is the flag's payload, not a string in this repo: either
 * a plain string, or an object keyed by locale ("en-US", "nl-NL") so the words
 * and the number live with the flag and change without a deploy. */
export const PRICE_ANCHOR_FLAG = "pricing-price-anchor";

/** The line for this locale from the flag payload, or null when the payload
 * is absent or malformed. Never throws. */
export const readPriceAnchorLine = (locale: string): string | null => {
	try {
		const payload = posthog.getFeatureFlagPayload(PRICE_ANCHOR_FLAG) as unknown;
		if (!payload || typeof payload !== "object") return null;
		const line = (payload as { line?: unknown }).line;
		if (typeof line === "string") return line.trim() || null;
		if (line && typeof line === "object") {
			const byLocale = line as Record<string, unknown>;
			const pick =
				byLocale[locale] ?? byLocale[locale.split("-")[0]] ?? byLocale["en-US"];
			return typeof pick === "string" && pick.trim() ? pick : null;
		}
		return null;
	} catch {
		return null;
	}
};

/** `anchor` shows the line. Everything else, including a flag that has not
 * resolved and a PostHog that never loaded, is `none`. */
export type PriceAnchorVariant = "anchor" | "none";

/** Read the flag once, safely.
 *
 * Any answer other than the one variant is `none`. An unresolved flag returns
 * undefined and lands on `none` too, which is the quiet side: a person must
 * never see a price because a network call was slow.
 */
export const readPriceAnchorVariant = (): PriceAnchorVariant => {
	try {
		return posthog.getFeatureFlag(PRICE_ANCHOR_FLAG) === "anchor"
			? "anchor"
			: "none";
	} catch {
		// PostHog is not initialised on every surface this component can mount
		// on, and a missing analytics client must never take a paying screen
		// with it.
		return "none";
	}
};

/** The variant for this render, kept current as the flags land.
 *
 * Flags often arrive after the first paint. Without the subscription the
 * opening would be drawn from an unresolved flag and stay that way for the
 * whole session, so the flag would under count its own variant.
 */
export const usePriceAnchorVariant = (
	locale: string,
): { variant: PriceAnchorVariant; line: string | null } => {
	const [state, setState] = useState(() => ({
		line: readPriceAnchorLine(locale),
		variant: readPriceAnchorVariant(),
	}));

	useEffect(() => {
		const read = () =>
			setState({
				line: readPriceAnchorLine(locale),
				variant: readPriceAnchorVariant(),
			});
		read();
		try {
			return posthog.onFeatureFlags(read);
		} catch {
			return undefined;
		}
	}, [locale]);

	return state;
};
