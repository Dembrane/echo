import { t } from "@lingui/core/macro";
import { Avatar, Tooltip } from "@mantine/core";
import { PlusIcon } from "@phosphor-icons/react";
import { PersonAvatar } from "@/components/common/UserAvatar";
import type { RoomPersonT } from "../../contract/contract.gen";
import { roomPictures } from "./model";
import classes from "./RoomPictures.module.css";

/** Past this many pictures, the rest are a "+n". */
const SHOWN = 4;

/**
 * The room's people at the top corner of Overview, Tasks and Documents: those who take
 * part first, joined drawn bright, invited faded with the tooltip saying so, then "+n",
 * then a "+" that opens the add flow (the Members page's "+" bubble). It says who is in,
 * never who has seen what.
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
		<Tooltip.Group openDelay={200} closeDelay={100}>
			<Avatar.Group spacing="sm" data-testid="room-pictures">
				{shown.map(({ person, joined }) => {
					const name = person.name;
					const label = joined ? name : t`${name} · invited, not joined yet`;
					return (
						<Tooltip key={person.email} label={label} withArrow>
							<span
								className={classes.picture}
								role="img"
								aria-label={label}
								data-joined={joined ? "yes" : "no"}
								data-testid="room-picture"
							>
								<PersonAvatar person={person} size={36} dimmed={!joined} />
							</span>
						</Tooltip>
					);
				})}
				{more > 0 && (
					<Avatar size={36} color="gray" aria-label={t`${more} more`}>
						+{more}
					</Avatar>
				)}
				<Tooltip label={t`Add someone`} withArrow>
					<Avatar
						component="button"
						type="button"
						size={36}
						color="primary"
						variant="light"
						className={classes.add}
						aria-label={t`Add someone`}
						onClick={onAdd}
						data-testid="room-pictures-add"
					>
						<PlusIcon size={16} />
					</Avatar>
				</Tooltip>
			</Avatar.Group>
		</Tooltip.Group>
	);
}
