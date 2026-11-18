import { t } from "@lingui/core/macro";
import { useAccountPage } from "../api/hooks";
import { AddPersonModal } from "./room/AddPersonModal";
import type { SignKind } from "./room/model";

/**
 * Handing a document to someone else to sign: the one person flow (AddPersonModal) with
 * the document's signing duty chosen, so they are named to sign and brought into the room
 * in one go, and a change of signer is confirmed inside the dialog. For owners and admins
 * only: the callers show it where the document says `may_name_signer`.
 */
export function SendToSomeoneElse({
	orgId,
	docId,
	opened,
	onClose,
}: {
	orgId: string;
	docId: string | null;
	opened: boolean;
	/** Kept for the callers; who signs now shows in the flow itself. */
	current?: { email: string; name: string | null; role: string | null } | null;
	onClose: () => void;
}) {
	const { data: page } = useAccountPage(opened ? orgId : undefined);
	const kind = page?.documents.find((d) => d.id === docId)?.kind;
	const signs: SignKind[] = kind === "offer" || kind === "dpa" ? [kind] : [];
	return (
		<AddPersonModal
			orgId={orgId}
			opened={opened && docId !== null && page !== undefined}
			onClose={onClose}
			preset={{ signs }}
			title={t`Send to someone else`}
		/>
	);
}
