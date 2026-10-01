import { t } from "@lingui/core/macro";
import type { PresentationBlock } from "@/components/present/blocks";

export function blockLabel(block: PresentationBlock) {
	return {
		map: t`Map`,
		popcorn: t`Popcorn`,
		stakeholders: t`Stakeholders`,
		tensions: t`Tensions`,
	}[block];
}
