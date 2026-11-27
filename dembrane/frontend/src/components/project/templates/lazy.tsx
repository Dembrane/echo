import { Skeleton, Stack } from "@mantine/core";
import type { ComponentProps } from "react";
import { createLazyNamedRoute } from "@/components/common/LazyRoute";
import type { AllFormats } from "./AllFormats/AllFormats";
import type { TemplateRow } from "./TemplateRow/TemplateRow";

/**
 * The create flow's choosing screens (ECHO-1058), loaded when they show: the row on the
 * start screen and all formats. They carry the sixteen drawings, which stay out of the
 * dashboard's first chunk the participant portal shares (scripts/check-portal-bundle.mjs).
 * A chunk that fails to load shows the error boundary's notice in their place.
 */
const Waiting = () => (
	<Stack gap="sm" aria-busy="true">
		<Skeleton height={24} w={240} />
		<Skeleton height={280} />
	</Stack>
);

export const LazyTemplateRow = createLazyNamedRoute<
	ComponentProps<typeof TemplateRow>
>(() => import("./TemplateRow/TemplateRow"), "TemplateRow", Waiting);

export const LazyAllFormats = createLazyNamedRoute<
	ComponentProps<typeof AllFormats>
>(() => import("./AllFormats/AllFormats"), "AllFormats", Waiting);
