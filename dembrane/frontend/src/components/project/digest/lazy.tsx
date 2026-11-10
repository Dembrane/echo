import { type ComponentProps, lazy, Suspense } from "react";

/**
 * The digest's blocks, loaded when the create flow shows them (ECHO-1055). The create
 * route is in the dashboard's first chunk, which the participant portal shares; these
 * blocks, their catalog and above all the extractors (pdf.js, fflate) stay out of it
 * (scripts/check-portal-bundle.mjs). The extractors load later still, on the first drop.
 */
const DigestConnected = lazy(() => import("./DigestConnected"));
const NameStepDigestConnected = lazy(
	() => import("./NameStepDigest/NameStepDigestConnected"),
);

export const LazyDigest = (props: ComponentProps<typeof DigestConnected>) => (
	<Suspense fallback={null}>
		<DigestConnected {...props} />
	</Suspense>
);

export const LazyNameStepDigest = (
	props: ComponentProps<typeof NameStepDigestConnected>,
) => (
	<Suspense fallback={null}>
		<NameStepDigestConnected {...props} />
	</Suspense>
);
