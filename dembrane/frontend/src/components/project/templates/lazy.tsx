import { Skeleton, Stack } from "@mantine/core";
import { type ComponentProps, lazy, Suspense } from "react";

/**
 * The create flow's choosing screens (ECHO-1058), loaded when they show: the row on the
 * start screen and all formats. They carry the sixteen drawings, which stay out of the
 * dashboard's first chunk the participant portal shares (scripts/check-portal-bundle.mjs).
 */
const TemplateRow = lazy(() =>
	import("./TemplateRow/TemplateRow").then((m) => ({ default: m.TemplateRow })),
);
const AllFormats = lazy(() =>
	import("./AllFormats/AllFormats").then((m) => ({ default: m.AllFormats })),
);

const Waiting = () => (
	<Stack gap="sm" aria-busy="true">
		<Skeleton height={24} w={240} />
		<Skeleton height={280} />
	</Stack>
);

export const LazyTemplateRow = (props: ComponentProps<typeof TemplateRow>) => (
	<Suspense fallback={<Waiting />}>
		<TemplateRow {...props} />
	</Suspense>
);

export const LazyAllFormats = (props: ComponentProps<typeof AllFormats>) => (
	<Suspense fallback={<Waiting />}>
		<AllFormats {...props} />
	</Suspense>
);
