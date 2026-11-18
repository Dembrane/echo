import { Stack } from "@mantine/core";
import { useState } from "react";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useAccountsMutation, useRoom } from "../../api/hooks";
import type { RoomPersonT } from "../../contract/contract.gen";
import { AddPersonModal } from "./AddPersonModal";
import { confirmRemove } from "./confirm";
import { FirstVisitQuestion } from "./FirstVisitQuestion";
import type { SignKind } from "./model";
import { type AddPreset, PeopleList } from "./PeopleList";

/**
 * Who is involved, connected: the room's people from the server, the first-visit question
 * above them when it is asked, and every write (add, change what someone does, take
 * someone out, wave a hint away) through the accounts mutations, which refresh the room.
 * A refusal shows in the server's own words.
 */
export function RoomSection({ orgId }: { orgId: string }) {
	const { data: page } = useRoom(orgId);
	// The preset stays while a dialog closes, so its steps do not change under the fade.
	const [adding, setAdding] = useState<AddPreset>({});
	const [addOpen, setAddOpen] = useState(false);
	const [changing, setChanging] = useState<RoomPersonT | null>(null);
	const [changeOpen, setChangeOpen] = useState(false);
	const remove = useAccountsMutation("removeRoomPerson", { orgId });
	const dismiss = useAccountsMutation("dismissRoomHint", { orgId });
	const answer = useAccountsMutation("answerRoomLabels", { orgId });
	if (!page?.me) return null;
	const me = page.me;
	const mine = page.people.find((p) => p.app_user_id === me.app_user_id);
	const signHref = (kind: SignKind) => {
		const id = page.signers[kind]?.document_id;
		return id ? `/o/${orgId}/account/documents/${id}/sign` : null;
	};
	return (
		<Stack gap="md">
			{me.labels_question && mine && (
				<FirstVisitQuestion
					inviter={mine.invited_by?.name ?? null}
					labels={mine.labels}
					other={mine.other}
					onAnswer={(body) => answer.mutateAsync({ body })}
				/>
			)}
			<PeopleList
				lens="decision"
				page={page}
				signHref={signHref}
				onAdd={(preset) => {
					setAdding(preset ?? {});
					setAddOpen(true);
				}}
				onChange={(person) => {
					setChanging(person);
					setChangeOpen(true);
				}}
				onRemove={(person) =>
					confirmRemove({
						onConfirm: () =>
							remove.mutate({ params: { personId: person.id ?? "" } }),
						person,
					})
				}
				onDismissHint={(label) => dismiss.mutate({ params: { label } })}
			/>
			{remove.error ? <ErrorNotice error={remove.error} /> : null}
			{dismiss.error ? <ErrorNotice error={dismiss.error} /> : null}
			<AddPersonModal
				orgId={orgId}
				opened={addOpen}
				preset={adding}
				onClose={() => setAddOpen(false)}
			/>
			<AddPersonModal
				orgId={orgId}
				opened={changeOpen}
				change
				preset={
					changing
						? {
								person: { email: changing.email, name: changing.name },
							}
						: undefined
				}
				onClose={() => setChangeOpen(false)}
			/>
		</Stack>
	);
}
