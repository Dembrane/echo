import type { ComponentProps } from "react";
import { createLazyNamedRoute } from "@/components/common/LazyRoute";
import type { SessionBriefConnected } from "./SessionBrief/SessionBriefConnected";
import type { SuggestKeyTermsConnected } from "./SuggestKeyTerms/SuggestKeyTermsConnected";

/**
 * The setup suggestion blocks, loaded when a screen shows them. The create route and the
 * portal editor are in the dashboard's first chunk, which the participant portal shares;
 * the blocks stay out of it (scripts/check-portal-bundle.mjs). They are optional: while
 * loading, or when their chunk fails, nothing shows.
 */
const Nothing = () => null;

export const LazySessionBrief = createLazyNamedRoute<
	ComponentProps<typeof SessionBriefConnected>
>(
	() => import("./SessionBrief/SessionBriefConnected"),
	"SessionBriefConnected",
	Nothing,
	null,
);

export const LazySuggestKeyTerms = createLazyNamedRoute<
	ComponentProps<typeof SuggestKeyTermsConnected>
>(
	() => import("./SuggestKeyTerms/SuggestKeyTermsConnected"),
	"SuggestKeyTermsConnected",
	Nothing,
	null,
);
