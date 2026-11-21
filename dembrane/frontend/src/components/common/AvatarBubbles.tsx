import { Avatar, Tooltip } from "@mantine/core";
import { PlusIcon } from "@phosphor-icons/react";
import type { ReactElement } from "react";
import classes from "./AvatarBubbles.module.css";

/** The class of a picture you press (a pointer, as on any button). */
export const pressable = classes.press;

export interface Bubble {
	key: string;
	/** The tooltip, and what the picture is called when read aloud. */
	label: string;
	/** The picture: an Avatar, or an element wrapping one, that takes a ref. */
	picture: ReactElement;
}

/**
 * People as a row of overlapping round pictures, each named in its tooltip, then "+n" for
 * those not shown, then a "+" to add or manage people. The Members bubbles of the
 * organisation overview and the data room's pictures at a page's top corner.
 */
export function AvatarBubbles({
	people,
	more = 0,
	moreLabel,
	onMore,
	add,
	testId,
}: {
	people: Bubble[];
	/** How many are not shown. */
	more?: number;
	moreLabel?: string;
	onMore?: () => void;
	add?: { label: string; onClick: () => void; testId?: string };
	testId?: string;
}) {
	return (
		<Tooltip.Group openDelay={200} closeDelay={100}>
			<Avatar.Group spacing="sm" data-testid={testId}>
				{people.map((p) => (
					<Tooltip key={p.key} label={p.label} withArrow>
						{p.picture}
					</Tooltip>
				))}
				{more > 0 && (
					<Avatar
						size={36}
						color="gray"
						aria-label={moreLabel}
						{...(onMore && {
							className: classes.press,
							component: "button" as const,
							onClick: onMore,
							type: "button",
						})}
					>
						+{more}
					</Avatar>
				)}
				{add && (
					<Tooltip label={add.label} withArrow>
						<Avatar
							component="button"
							type="button"
							size={36}
							color="primary"
							variant="light"
							className={classes.press}
							aria-label={add.label}
							onClick={add.onClick}
							data-testid={add.testId}
						>
							<PlusIcon size={16} />
						</Avatar>
					</Tooltip>
				)}
			</Avatar.Group>
		</Tooltip.Group>
	);
}
