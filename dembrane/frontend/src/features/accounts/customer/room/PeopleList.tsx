import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	Anchor,
	Button,
	Group,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import {
	InfoIcon,
	MagnifyingGlassIcon,
	PlusIcon,
	UserCirclePlusIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import type {
	RoomLabelT,
	RoomPageT,
	RoomPersonT,
} from "../../contract/contract.gen";
import { FitLabel, fitting } from "../../FitLabel";
import { PageSection, Row, Rows } from "../PageSection";
import { hintText } from "./copy";
import {
	accessOrder,
	decisionSplit,
	type HintLabelT,
	type Lens,
	notInRoom,
	openHints,
	type SignKind,
} from "./model";
import classes from "./PeopleList.module.css";
import { PersonRow } from "./PersonRow";

/** What the add flow starts with: labels chosen, or a member already known. */
export type AddPreset = {
	labels?: RoomLabelT[];
	person?: { email: string; name: string };
	signs?: SignKind[];
};

/**
 * The one people component, in two lenses. Decision ("Who is involved"): those who sign
 * or say what they do lead; everyone else folds into "Other members" under them, with, for
 * those who run the account, the members not added yet. One "nobody does this yet" hint
 * at a time sits between the two. Access (the Members page): the same people by
 * organisation role. Props in, callbacks out: RoomSection fetches and writes.
 */
export function PeopleList({
	lens,
	page,
	onAdd,
	onChange,
	onRemove,
	onDismissHint,
	signHref,
}: {
	lens: Lens;
	page: RoomPageT;
	onAdd: (preset?: AddPreset) => void;
	onChange: (person: RoomPersonT) => void;
	onRemove: (person: RoomPersonT) => void;
	onDismissHint: (label: HintLabelT) => void;
	/** Where a signing marker's document opens. */
	signHref?: (kind: SignKind) => string | null;
}) {
	const { me } = page;
	const row = (p: RoomPersonT) => (
		<PersonRow
			key={p.email}
			lens={lens}
			person={p}
			me={me}
			signHref={signHref}
			onChange={() => onChange(p)}
			onRemove={() => onRemove(p)}
			onBringIn={() => onAdd({ person: { email: p.email, name: p.name } })}
		/>
	);
	const inRoom = page.people.filter((p) => p.room !== "none");
	const addButton = me && (
		<Button
			variant="outline"
			leftSection={<PlusIcon size={16} aria-hidden />}
			onClick={() => onAdd()}
			data-testid="room-add"
			{...fitting}
		>
			<FitLabel short={<Trans>Add</Trans>}>
				<Trans>Add someone</Trans>
			</FitLabel>
		</Button>
	);

	if (lens === "access")
		return (
			<div data-testid="people-list" data-lens="access">
				<PageSection
					title={<Trans>Members</Trans>}
					count={page.people.length}
					action={addButton}
				>
					<Rows>{accessOrder(page.people).map(row)}</Rows>
				</PageSection>
			</div>
		);

	const { lead, others } = decisionSplit(page.people);
	// Those who run the account see every member, so the ones not added yet are here too.
	const fold = [...others, ...notInRoom(page.people)].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	const alone = inRoom.every(
		(p) => p.app_user_id !== null && p.app_user_id === me?.app_user_id,
	);
	const hint = alone ? null : (openHints(page)[0] ?? null);
	return (
		<div data-testid="people-list" data-lens="decision">
			<PageSection
				title={
					<span className={classes.title}>
						<Trans>Who is involved</Trans>
						<Text span size="xs" c="dimmed" ml="xs" data-testid="section-count">
							{inRoom.length}
						</Text>
						<Tooltip
							multiline
							w={280}
							label={t`Everyone added here can read the offer and the DPA. Invoices and billing details stay with owners, admins and Billing.`}
						>
							<InfoIcon
								size={16}
								aria-label={t`Who reads what`}
								className={classes.info}
							/>
						</Tooltip>
					</span>
				}
				action={addButton}
			>
				<Rows>
					{lead.map(row)}
					{alone ? (
						<Quiet testId="room-empty">
							<Trans>
								Nobody else yet. Add the colleagues who decide on this offer
								with you.
							</Trans>
						</Quiet>
					) : (
						hint && (
							<Quiet
								testId="room-hint"
								label={hint}
								actions={
									<Group gap="md">
										<Anchor
											component="button"
											size="sm"
											onClick={() => onAdd({ labels: [hint] })}
											data-testid="hint-add"
										>
											<Trans>Add someone</Trans>
										</Anchor>
										{me?.may_dismiss_hints && (
											<Anchor
												component="button"
												size="sm"
												onClick={() => onDismissHint(hint)}
												data-testid="hint-dismiss"
											>
												<Trans>Not needed</Trans>
											</Anchor>
										)}
									</Group>
								}
							>
								{hintText(hint)}
							</Quiet>
						)
					)}
				</Rows>
				{fold.length > 0 && <OtherMembers people={fold} row={row} />}
			</PageSection>
		</div>
	);
}

/** A quiet row under the people: a fact in the muted colour, and what can be done about it. */
function Quiet({
	children,
	actions,
	testId,
	label,
}: {
	children: ReactNode;
	actions?: ReactNode;
	testId: string;
	label?: string;
}) {
	return (
		<Row testId={testId} data-label={label}>
			<div className={classes.person}>
				<div className={classes.marker}>
					<UserCirclePlusIcon size={20} color="var(--app-muted)" aria-hidden />
				</div>
				<Text
					size="sm"
					lh="24px"
					c="dimmed"
					className={actions ? classes.who : classes.wide}
				>
					{children}
				</Text>
				{actions && <div className={classes.tags}>{actions}</div>}
				<div />
			</div>
		</Row>
	);
}

/** Past this many, the fold offers a search and shows the first ones only. */
const FIRST = 12;

/**
 * Everyone who does not take part in the decision, folded under the list, closed. Open,
 * it reads as part of its header: no rule between them, the rows on the list's own grid.
 * Many members get a search and a "Show all".
 */
function OtherMembers({
	people,
	row,
}: {
	people: RoomPersonT[];
	row: (p: RoomPersonT) => ReactNode;
}) {
	const [query, setQuery] = useState("");
	const [all, setAll] = useState(false);
	const q = query.trim().toLowerCase();
	const found = q
		? people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(q))
		: people;
	const shown = all || q ? found : found.slice(0, FIRST);
	const count = people.length;
	return (
		<Accordion
			chevronPosition="left"
			classNames={{
				content: classes.foldContent,
				control: classes.foldControl,
				item: classes.foldItem,
			}}
			data-testid="other-members"
		>
			<Accordion.Item value="others">
				<Accordion.Control data-testid="other-members-toggle">
					<Text span>
						<Trans>Other members</Trans>
					</Text>
					<Text span size="xs" c="dimmed" ml="xs">
						{count}
					</Text>
				</Accordion.Control>
				<Accordion.Panel>
					{count > FIRST && (
						<TextInput
							placeholder={t`Find someone`}
							aria-label={t`Find someone`}
							leftSection={<MagnifyingGlassIcon size={16} aria-hidden />}
							value={query}
							onChange={(e) => setQuery(e.currentTarget.value)}
							className={classes.find}
							data-testid="other-members-find"
						/>
					)}
					<Rows>{shown.map(row)}</Rows>
					{!all && !q && found.length > FIRST && (
						<Anchor
							component="button"
							size="sm"
							className={classes.more}
							onClick={() => setAll(true)}
							data-testid="other-members-all"
						>
							<Trans>Show all {count}</Trans>
						</Anchor>
					)}
					{q && found.length === 0 && (
						<Text size="sm" c="dimmed" className={classes.more}>
							<Trans>Nobody by that name or email.</Trans>
						</Text>
					)}
				</Accordion.Panel>
			</Accordion.Item>
		</Accordion>
	);
}
