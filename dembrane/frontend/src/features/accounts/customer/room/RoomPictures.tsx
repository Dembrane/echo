import { t } from "@lingui/core/macro";
import { AvatarBubbles } from "@/components/common/AvatarBubbles";
import { PersonAvatar } from "@/components/common/UserAvatar";
import type { RoomPersonT } from "../../contract/contract.gen";
import { roomPictures } from "./model";
import classes from "./RoomPictures.module.css";

/** Past this many pictures, the rest are a "+n". */
const SHOWN = 4;

/**
 * The room's people at the top corner of Overview, Tasks and Documents: those who take
 * part first, joined drawn bright, invited faded with the tooltip saying so, then "+n",
 * then a "+" that opens the add flow (the Members page's bubbles, AvatarBubbles). It says
 * who is in, never who has seen what.
 */
export function RoomPictures({
	people,
	onAdd,
}: {
	people: RoomPersonT[];
	onAdd: () => void;
}) {
	const pics = roomPictures(people);
	const shown = pics.slice(0, SHOWN);
	const more = pics.length - shown.length;
	return (
		<AvatarBubbles
			testId="room-pictures"
			people={shown.map(({ person, joined }) => {
				const name = person.name;
				const label = joined ? name : t`${name} · invited, not joined yet`;
				return {
					key: person.email,
					label,
					picture: (
						<span
							className={classes.picture}
							role="img"
							aria-label={label}
							data-joined={joined ? "yes" : "no"}
							data-testid="room-picture"
						>
							<PersonAvatar person={person} size={36} dimmed={!joined} />
						</span>
					),
				};
			})}
			more={more}
			moreLabel={t`${more} more`}
			add={{
				label: t`Add someone`,
				onClick: onAdd,
				testId: "room-pictures-add",
			}}
		/>
	);
}
