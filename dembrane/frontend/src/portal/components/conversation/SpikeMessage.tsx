import { Group, Loader } from "@mantine/core";
import clsx from "clsx";
import { Logo } from "@/components/common/Logo";
import SystemMessage from "./SystemMessage";

const SpikeMessage = ({
	message,
	loading,
	className,
	dataTestId,
}: {
	message: ConversationReply;
	loading?: boolean;
	className?: string;
	dataTestId?: string;
}) => {
	if (message?.type === "assistant_reply") {
		return (
			<SystemMessage
				markdown={message.content_text ?? ""}
				title={
					<Group>
						{loading ? (
							<Loader size="sm" my="xs" />
						) : (
							<Logo
								className="min-w-[20px]"
								hideTitle
								hideEnvBadge
								alwaysDembrane
								h="20px"
								my="xs"
							/>
						)}
					</Group>
				}
				className={clsx("py-5 px-0 md:py-7", className)}
				dataTestId={dataTestId}
			/>
		);
	}
	return null;
};

export default SpikeMessage;
