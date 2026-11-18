import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Anchor, Menu, Text } from "@mantine/core";
import { DotsThreeIcon } from "@phosphor-icons/react";
import { PersonAvatar } from "@/components/common/UserAvatar";
import { displayRole } from "@/lib/roles";
import type { RoomPersonT } from "../../contract/contract.gen";
import { Row } from "../PageSection";
import { labelText, signText } from "./copy";
import {
	firstName,
	inLabelOrder,
	type Lens,
	type RoomMe,
	type SignKind,
} from "./model";
import classes from "./PeopleList.module.css";
import { PersonTags } from "./Tags";

/**
 * One person, the same in both lenses: picture, name and email on the left, their menu
 * on the right. The middle says what the lens is about. Decision: what they do, as tags
 * (signing first, outlined blue; labels in the quiet tint). Access: their organisation
 * role and whether they read the offer, with what they do following quietly in words.
 * A member not added yet is marked so, with one action: add them.
 */
export function PersonRow({
	lens,
	person,
	me,
	signHref,
	onChange,
	onRemove,
	onBringIn,
}: {
	lens: Lens;
	person: RoomPersonT;
	me: RoomMe | null;
	signHref?: (kind: SignKind) => string | null;
	onChange: () => void;
	onRemove: () => void;
	onBringIn: () => void;
}) {
	const first = firstName(person);
	const you =
		person.app_user_id !== null && person.app_user_id === me?.app_user_id;
	const invited = person.status === "invited";
	const outside = person.room === "none";
	const change = person.may_relabel;
	const remove = person.may_remove;
	return (
		<Row testId="room-person" data-email={person.email}>
			<div className={classes.person}>
				<div className={classes.marker}>
					<PersonAvatar person={person} size={32} dimmed={invited} />
				</div>
				<div className={classes.who}>
					<Text lh="24px">
						{person.name}
						{(you || invited || outside) && (
							<Text
								span
								size="xs"
								c="dimmed"
								className={classes.status}
								data-outside={(!you && !invited && outside) || undefined}
							>
								{you ? (
									<Trans>you</Trans>
								) : invited ? (
									<Trans>invited</Trans>
								) : (
									<Trans>not added yet</Trans>
								)}
							</Text>
						)}
					</Text>
					<Text size="xs" lh="20px" c="dimmed">
						{person.email}
					</Text>
				</div>
				<div className={classes.tags}>
					{lens === "access" ? (
						<AccessFacts person={person} />
					) : outside ? (
						me && (
							<Anchor
								component="button"
								size="sm"
								lh="24px"
								onClick={onBringIn}
								data-testid="person-bring-in"
							>
								<Trans>Involve {first} in procurement</Trans>
							</Anchor>
						)
					) : (
						<PersonTags
							labels={person.labels}
							other={person.other}
							signs={person.signs}
							signHref={signHref}
						/>
					)}
				</div>
				<div>
					{(change || remove) && (
						<Menu position="bottom-end" withinPortal>
							<Menu.Target>
								<ActionIcon
									variant="subtle"
									color="gray"
									aria-label={t`Options for ${first}`}
									data-testid="person-menu"
								>
									<DotsThreeIcon size={20} />
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown>
								{change && (
									<Menu.Item onClick={onChange} data-testid="person-change">
										<Trans>Change what {first} does</Trans>
									</Menu.Item>
								)}
								{remove && (
									<Menu.Item
										color="red"
										onClick={onRemove}
										data-testid="person-remove"
									>
										<Trans>Remove {first}</Trans>
									</Menu.Item>
								)}
							</Menu.Dropdown>
						</Menu>
					)}
				</div>
			</div>
		</Row>
	);
}

/** The access lens: role and room access lead; what they do follows quietly, in words. */
function AccessFacts({ person }: { person: RoomPersonT }) {
	const role = person.org_role ? displayRole(person.org_role) : t`Invited`;
	const reads =
		person.room === "none" ? t`Not added yet` : t`Reads the offer and the DPA`;
	const doing = [
		...person.signs.map(signText),
		...inLabelOrder(person.labels).map(labelText),
		...(person.other?.trim() ? [person.other.trim()] : []),
	];
	return (
		<>
			<Text size="sm" lh="24px" data-testid="access-facts">
				{`${role} · ${reads}`}
			</Text>
			{doing.length > 0 && (
				<Text size="xs" lh="20px" c="dimmed">
					{doing.join(", ")}
				</Text>
			)}
		</>
	);
}
