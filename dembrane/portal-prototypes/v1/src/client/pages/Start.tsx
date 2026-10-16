import { Empty, LinkButton, Loader } from "@cloudflare/kumo";
import { ChatsCircleIcon, GearSixIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { getAccess } from "../api";
import { ProjectNotFound, Shell } from "../ui";

/** Where a participant starts. Not built yet. A host also gets a link to the settings. */
export function Start({ projectId, base }: { projectId: string; base: string }) {
  const [found, setFound] = useState<boolean | undefined>(undefined);
  const [host, setHost] = useState(false);

  useEffect(() => {
    getAccess(projectId).then((res) => {
      setFound(res.ok || res.status !== 404);
      setHost(res.ok && res.body.host);
    });
  }, [projectId]);

  if (found === false) return <ProjectNotFound />;
  const settings = host && (
    <LinkButton
      href={`${base}/host`}
      variant="ghost"
      shape="square"
      aria-label="Project settings"
      title="Project settings"
      icon={<GearSixIcon size={16} />}
    />
  );
  return (
    <Shell title="Participant portal" actions={settings}>
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
