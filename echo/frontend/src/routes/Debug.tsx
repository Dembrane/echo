import { Button, Stack, Title } from "@mantine/core";
import { toast } from "@/components/common/Toaster";
import { useRef } from "react";
import { useParams } from "react-router-dom";
import { useCurrentUser, useProjectById, useProjectChats } from "@/lib/query";
import {
  ENABLE_CHAT_AUTO_SELECT,
  API_BASE_URL,
  DIRECTUS_PUBLIC_URL,
  ADMIN_BASE_URL,
  PARTICIPANT_BASE_URL,
  BUILD_VERSION,
  DIRECTUS_CONTENT_PUBLIC_URL,
  SUPPORTED_LANGUAGES,
} from "@/config";

export default function DebugPage() {
  const ref = useRef<number>(0);
  const handleTestToast = () => {
    if (ref.current === 0) {
      toast.success("Test toast");
    } else if (ref.current === 1) {
      toast.error("Test toast");
    } else if (ref.current === 2) {
      toast.warning("Test toast");
    } else if (ref.current === 3) {
      toast.info("Test toast");
    } else if (ref.current === 4) {
      toast.error("Test toast");
    } else {
      toast("Test toast");
    }

    ref.current++;
  };

  const { projectId } = useParams();

  const { data: user } = useCurrentUser();

  const { data: project } = useProjectById({ projectId: projectId! });

  const { data: chats } = useProjectChats(projectId!, {
    filter: {
      project_id: {
        _eq: projectId,
      },
      "count(project_chat_messages)": {
        // @ts-ignore
        _gt: 0,
      },
    },
  });

  const variables = {
    DEBUG_MODE: true,
    BUILD_VERSION,
    ff: {
      ENABLE_CHAT_AUTO_SELECT,
      SUPPORTED_LANGUAGES,
    },
    urls: {
      API_BASE_URL,
      DIRECTUS_PUBLIC_URL,
      DIRECTUS_CONTENT_PUBLIC_URL,
      ADMIN_BASE_URL,
      PARTICIPANT_BASE_URL,
    },
  };

  return (
    <Stack className="p-8">
      <Stack>
        <Title order={1}>Debug</Title>
        <Stack>
          <pre>{JSON.stringify(variables, null, 2)}</pre>
        </Stack>
        <div>
          <Button onClick={handleTestToast}>Test Toast</Button>
        </div>
      </Stack>
      <Stack>
        <Title order={1}>User</Title>
        <pre>{JSON.stringify(user, null, 2)}</pre>
      </Stack>
      <Stack>
        <Title order={1}>Project</Title>
        <pre>{JSON.stringify(project, null, 2)}</pre>
      </Stack>
      <Stack>
        <Title order={1}>Chats (NE)</Title>
        <pre>{JSON.stringify(chats, null, 2)}</pre>
      </Stack>
    </Stack>
  );
}
