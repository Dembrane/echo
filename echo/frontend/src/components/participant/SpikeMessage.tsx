import { Group } from "@mantine/core";
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
						<div className={loading ? "animate-spin" : ""}>
							<Logo className="min-w-[20px]" hideTitle h="20px" my={4} />
						</div>
					</Group>
				}
				className={clsx(
					"border-0 !rounded-br-none py-5 px-0 md:py-7",
					className,
				)}
				dataTestId={dataTestId}
			/>
		);
	}
	return null;
};

export default SpikeMessage;
