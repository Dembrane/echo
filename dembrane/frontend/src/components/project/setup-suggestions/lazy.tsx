import { type ComponentProps, lazy, Suspense } from "react";

/**
 * The setup suggestion blocks, loaded when a screen shows them. The create route and the
 * portal editor are in the dashboard's first chunk, which the participant portal shares;
 * the blocks stay out of it (scripts/check-portal-bundle.mjs).
 */
const SessionBriefConnected = lazy(() =>
	import("./SessionBrief/SessionBriefConnected").then((m) => ({
		default: m.SessionBriefConnected,
	})),
);
const SuggestKeyTermsConnected = lazy(() =>
	import("./SuggestKeyTerms/SuggestKeyTermsConnected").then((m) => ({
		default: m.SuggestKeyTermsConnected,
	})),
);

export const LazySessionBrief = (
	props: ComponentProps<typeof SessionBriefConnected>,
) => (
	<Suspense fallback={null}>
		<SessionBriefConnected {...props} />
	</Suspense>
);

export const LazySuggestKeyTerms = (
	props: ComponentProps<typeof SuggestKeyTermsConnected>,
) => (
	<Suspense fallback={null}>
		<SuggestKeyTermsConnected {...props} />
	</Suspense>
);
