import { t } from "@lingui/core/macro";
import type { SectionKey } from "./portalForm";

export const sectionTitle = (section: SectionKey): string => {
	switch (section) {
		case "welcome":
			return t`Welcome`;
		case "privacy":
			return t`Privacy`;
		case "about":
			return t`About`;
		case "explore":
			return t`Explore`;
		case "verify":
			return t({ id: "dashboard.dembrane.verify.title", message: "Verify" });
		case "finish":
			return t`Finish`;
	}
};

/** What a page sets up, in one line under its title. */
export const sectionDescription = (section: SectionKey): string => {
	switch (section) {
		case "welcome":
			return t`The portal's language, what participants read first and the tutorial cards.`;
		case "privacy":
			return t`Who is responsible for the data, and whether transcripts are anonymised.`;
		case "about":
			return t`What the start screen asks, and how conversations get their titles.`;
		case "explore":
			return t`A question from dembrane, when a group asks for one, to go deeper.`;
		case "verify":
			return t`A short draft participants check and approve before they finish.`;
		case "finish":
			return t`The thank you page participants see at the end.`;
	}
};
