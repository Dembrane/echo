import type { ComponentProps } from "react";
import { createLazyRoute } from "@/components/common/LazyRoute";
import type DigestConnected from "./DigestConnected";
import type NameStepDigestConnected from "./NameStepDigest/NameStepDigestConnected";

/**
 * The digest's blocks, loaded when the create flow shows them (ECHO-1055). The create
 * route is in the dashboard's first chunk, which the participant portal shares; these
 * blocks, their catalog and above all the extractors (pdf.js, fflate) stay out of it
 * (scripts/check-portal-bundle.mjs). The extractors load later still, on the first drop.
 * The blocks are optional: while loading, or when their chunk fails, nothing shows.
 */
const Nothing = () => null;

export const LazyDigest = createLazyRoute<
	ComponentProps<typeof DigestConnected>
>(() => import("./DigestConnected"), Nothing, null);

export const LazyNameStepDigest = createLazyRoute<
	ComponentProps<typeof NameStepDigestConnected>
>(() => import("./NameStepDigest/NameStepDigestConnected"), Nothing, null);
