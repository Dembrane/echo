import { Group } from "@mantine/core";
import SystemMessage from "./SystemMessage";
import { Logo } from "@/components/common/Logo";
import clsx from "clsx";

const SpikeMessage = ({
  message,
  loading,
  className,
}: {
  message: ConversationReply;
  loading?: boolean;
  className?: string;
}) => {
  if (message?.type === "assistant_reply") {
    return (
      <SystemMessage
        markdown={message.content_text ?? ""}
        title={
          <Group>
            <div className={loading ? "animate-spin" : ""}>
              <Logo hideTitle h="20px" my={4} />
            </div>
          </Group>
        }
        className={clsx("border-0", className)}
      />
    );
  }
  return null;
};

export default SpikeMessage;
