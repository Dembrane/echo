import { Empty } from "@cloudflare/kumo";
import { ChatsCircleIcon } from "@phosphor-icons/react";
import { Shell } from "../ui";

/** Where a participant starts. Not built yet. */
export function Start() {
  return (
    <Shell title="Participant portal">
      <Empty
        icon={<ChatsCircleIcon size={48} />}
        title="Participant portal"
        description="Not yet implemented."
      />
    </Shell>
  );
}
