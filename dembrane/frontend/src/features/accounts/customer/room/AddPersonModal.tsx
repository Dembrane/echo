import { t } from "@lingui/core/macro";
import { Modal } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useState } from "react";
import { useV2Me } from "@/hooks/useV2Me";
import { useAccountPage, useAccountsMutation, useRoom } from "../../api/hooks";
import type { AccountPageT, RoomPageT } from "../../contract/contract.gen";
import { AddPersonSteps, type Signing } from "./AddPersonSteps";
import { firstName, mayNameSigner, type SignKind } from "./model";
import type { AddPreset } from "./PeopleList";

/**
 * The one way to bring a person in or change what they do, in a dialog: from "Add
 * someone", a hint, a member not added yet, "Share" on a document, who signs and "Send to
 * someone else". Each opening starts over. On a phone it fills the screen, as the Share
 * dialog does, with the row of steps kept in view.
 */
export function AddPersonModal({
	orgId,
	opened,
	onClose,
	preset,
	title,
	change = false,
}: {
	orgId: string;
	opened: boolean;
	onClose: () => void;
	preset?: AddPreset;
	/** The dialog's title; "Add someone" by default. */
	title?: string;
	/** Change what someone already in does (preset.person). */
	change?: boolean;
}) {
	const { data: room } = useRoom(orgId, opened);
	const { data: page } = useAccountPage(opened ? orgId : undefined);
	const { data: me } = useV2Me({ enabled: opened });
	const add = useAccountsMutation("addRoomPerson", { orgId });
	const name = useAccountsMutation("nameSigner", { orgId });
	const phone = useMediaQuery("(max-width: 48em)") ?? false;
	const [stepTitle, setStepTitle] = useState<string | null>(null);
	const roomMe = room?.me ?? null;
	const docs = room && page ? signable(room, page) : {};
	const signing: Signing | undefined =
		roomMe && Object.keys(docs).length
			? {
					docs,
					onName: (_kind, docId, body) =>
						name.mutateAsync({ body, params: { docId } }),
				}
			: undefined;
	const who = preset?.person;
	const first = who ? firstName(who) : "";
	const fallback =
		change && who ? t`Change what ${first} does` : t`Add someone`;
	return (
		<Modal
			opened={opened && room !== undefined && roomMe !== null}
			onClose={onClose}
			centered
			fullScreen={phone}
			title={stepTitle ?? title ?? fallback}
			data-testid="add-person"
			onExitTransitionEnd={() => setStepTitle(null)}
		>
			{room && roomMe && (
				<AddPersonSteps
					key={String(opened)}
					me={roomMe}
					myEmail={me?.email ?? ""}
					people={room.people}
					preset={preset}
					signing={signing}
					change={change}
					onSubmit={(body) => add.mutateAsync({ body })}
					onCancel={onClose}
					onDone={onClose}
					onTitle={setStepTitle}
				/>
			)}
		</Modal>
	);
}

/**
 * The offer and the DPA a signer can still be named on (sent or viewed, waiting for a
 * signature) by the person asking (the server's may_name_signer), each with who is named
 * now: the room's signer of that document.
 */
export function signable(room: RoomPageT, page: AccountPageT): Signing["docs"] {
	const out: Signing["docs"] = {};
	for (const kind of ["offer", "dpa"] as SignKind[]) {
		const named = room.signers[kind];
		const doc =
			page.documents.find((d) => d.id === named?.document_id) ??
			page.documents.find((d) => d.kind === kind);
		if (
			!doc ||
			doc.kind !== kind ||
			!mayNameSigner(doc) ||
			!doc.requires_signature ||
			(doc.status !== "sent" && doc.status !== "viewed")
		)
			continue;
		const signer = doc.signer
			? { email: doc.signer.email, name: doc.signer.name }
			: named && named.document_id === doc.id
				? { email: named.email, name: named.name }
				: null;
		out[kind] = { documentId: doc.id, signer };
	}
	return out;
}
