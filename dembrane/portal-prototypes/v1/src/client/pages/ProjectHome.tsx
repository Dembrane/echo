import { Badge, LayerCard, LinkButton, Loader, Text } from "@cloudflare/kumo";
import { ChatsCircleIcon, GearSixIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { getAccess } from "../api";
import { ProjectNotFound, Shell } from "../ui";

/**
 * A project's own link. Participants go straight on to /start; a host picks
 * between taking part and managing the project.
 */
export function ProjectHome({ projectId, base }: { projectId: string; base: string }) {
  const [role, setRole] = useState<string | null | undefined>(undefined);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    getAccess(projectId).then((res) => {
      if (!res.ok && res.status === 404) return setMissing(true);
      if (res.ok && res.body.host) return setRole(res.body.role);
      location.replace(`${base}/start`);
    });
  }, [projectId, base]);

  if (missing) return <ProjectNotFound />;
  if (role === undefined) {
    return (
      <Shell title="Project">
        <div className="flex justify-center py-12">
          <Loader size="lg" />
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Project">
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="secondary" size="sm">
          You're a host of this project.
        </Text>
        {role && <Badge variant="neutral">{role}</Badge>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Choice
          icon={<ChatsCircleIcon size={20} />}
          title="Participate"
          description="Open the portal as a participant sees it."
          href={`${base}/start`}
          action="Go to the portal"
        />
        <Choice
          icon={<GearSixIcon size={20} />}
          title="Manage"
          description="Change the project's settings."
          href={`${base}/host`}
          action="Open settings"
          primary
        />
      </div>
    </Shell>
  );
}

function Choice(props: {
  icon: React.ReactNode;
  title: string;
  description: string;
  href: string;
  action: string;
  primary?: boolean;
}) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center gap-2">
        {props.icon}
        {props.title}
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-4">
        <Text variant="secondary" size="sm">
          {props.description}
        </Text>
        <LinkButton href={props.href} variant={props.primary ? "primary" : "secondary"}>
          {props.action}
        </LinkButton>
      </LayerCard.Primary>
    </LayerCard>
  );
}
