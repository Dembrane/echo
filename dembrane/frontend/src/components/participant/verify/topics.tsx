import { t } from "@lingui/core/macro";
import {
	ArrowBendUpRightIcon,
	ArrowsLeftRightIcon,
	CheckSquareIcon,
	EarIcon,
	type Icon,
	LightbulbIcon,
	ListChecksIcon,
	MountainsIcon,
	SealCheckIcon,
} from "@phosphor-icons/react";

/**
 * The built-in Verify topics as hosts and participants see them (ECHO-1052): an icon and one
 * line saying what the draft holds. Labels come from the server (verify/src/defaults.ts), in
 * the order hosts see them; the keys are the ones stored in a project's selection.
 */
export const BUILT_IN_TOPIC_KEYS = [
	"agreements",
	"disagreements",
	"actions",
	"gems",
	"truths",
	"heard",
	"moments",
] as const;

const ICONS: Record<string, Icon> = {
	actions: ListChecksIcon,
	agreements: CheckSquareIcon,
	disagreements: ArrowsLeftRightIcon,
	gems: LightbulbIcon,
	heard: EarIcon,
	moments: ArrowBendUpRightIcon,
	truths: MountainsIcon,
};

/** The topic's icon; a host's own topic gets the Verify seal. */
export const TopicIcon = ({
	topicKey,
	size = 20,
}: {
	topicKey: string;
	size?: number;
}) => {
	const Component = ICONS[topicKey] ?? SealCheckIcon;
	return <Component size={size} aria-hidden="true" />;
};

/** One line on what a built-in topic gives back, or null for a host's own topic. */
export const topicDescription = (key: string): string | null => {
	switch (key) {
		case "agreements":
			return t`What this group mostly agreed on, and what differed.`;
		case "disagreements":
			return t`Where views stayed different, each side in one line.`;
		case "actions":
			return t`Actions and proposals said out loud, and who was named.`;
		case "gems":
			return t`Ideas mentioned only briefly that could matter.`;
		case "truths":
			return t`Problems, risks or doubts the group named itself.`;
		case "heard":
			return t`What this person or group told us, in their own words.`;
		case "moments":
			return t`Moments where the group's view changed.`;
		default:
			return null;
	}
};
