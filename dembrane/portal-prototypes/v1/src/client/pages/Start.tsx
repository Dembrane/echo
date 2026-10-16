import { Empty, Loader } from "@cloudflare/kumo";
import { ChatsCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { getAccess } from "../api";
import { ProjectNotFound, Shell } from "../ui";

/** Where a participant starts. Not built yet. */
export function Start({ projectId }: { projectId: string }) {
  const [found, setFound] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    getAccess(projectId).then((res) => setFound(res.ok || res.status !== 404));
  }, [projectId]);

  if (found === false) return <ProjectNotFound />;
  return (
    <Shell title="Participant portal">
      {found === undefined ? (
        <div className="flex justify-center py-12">
          <Loader size="lg" />
        </div>
      ) : (
        <Empty
          icon={<ChatsCircleIcon size={48} />}
          title="Participant portal"
          description="Not yet implemented."
        />
      )}
    </Shell>
  );
}
