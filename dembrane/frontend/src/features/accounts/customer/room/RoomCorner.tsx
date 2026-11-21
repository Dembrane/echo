import { useState } from "react";
import { useRoom } from "../../api/hooks";
import { AddPersonModal } from "./AddPersonModal";
import { RoomPictures } from "./RoomPictures";

/** The room's pictures, connected: the people from the server, "+" opening the add flow. */
export function RoomCorner({ orgId }: { orgId: string }) {
	const { data: page } = useRoom(orgId);
	const [open, setOpen] = useState(false);
	if (!page?.me) return null;
	return (
		<>
			<RoomPictures people={page.people} onAdd={() => setOpen(true)} />
			<AddPersonModal
				orgId={orgId}
				opened={open}
				onClose={() => setOpen(false)}
			/>
		</>
	);
}
