import { t } from "@lingui/core/macro";
import { Stack, Text } from "@mantine/core";
import { openConfirm } from "@/lib/openConfirm";
import type { RoomPersonT } from "../../contract/contract.gen";
import { removeConsequence } from "./copy";
import { firstName, type SignKind } from "./model";

/** Someone who signs a document now and would no longer sign it. */
export interface Replaced {
	kind: SignKind;
	name: string;
	email: string;
	/** The person looking signs it now. */
	isMe: boolean;
}

/** The question a signer change asks: the dialog's title while the step shows. */
export const signerQuestion = (replaced: { kind: SignKind }[]): string =>
	replaced.length > 1
		? t`Change who signs both documents?`
		: replaced[0]?.kind === "dpa"
			? t`Change who signs the DPA?`
			: t`Change who signs the offer?`;

/**
 * Before a signing duty moves to someone else: the person who had it loses their link to
 * sign, so it is said plainly, inside the same dialog, before anything is sent.
 */
export function NewSignerNotice({
	replaced,
	newName,
}: {
	replaced: Replaced[];
	newName: string;
}) {
	// One person losing both duties is told once.
	const people = replaced.filter(
		(r, i) => replaced.findIndex((x) => x.email === r.email) === i,
	);
	return (
		<Stack gap="xs" data-testid="new-signer-notice">
			{people.map((r) => {
				const oldName = r.name;
				const oldFirst = firstName(r);
				return (
					<Text key={r.email}>
						{r.isMe
							? t`You will not sign it. ${newName} gets a link to sign instead.`
							: t`${oldName} no longer signs it, and the link we sent ${oldFirst} stops working. ${newName} gets a new link.`}
					</Text>
				);
			})}
		</Stack>
	);
}

/**
 * Before someone is taken out: what it does, which differs before and after they joined.
 * The confirm pill first, as every confirmation in the app (openConfirm).
 */
export function confirmRemove({
	person,
	onConfirm,
}: {
	person: RoomPersonT;
	onConfirm: () => void;
}) {
	const name = person.name;
	const first = firstName(person);
	openConfirm({
		children: (
			<Text data-testid="remove-consequence">{removeConsequence(person)}</Text>
		),
		danger: true,
		labels: { confirm: t`Remove ${first}` },
		onConfirm,
		title: t`Remove ${name}?`,
	});
}
