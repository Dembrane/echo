import { Group } from "@mantine/core";
import clsx from "clsx";
import dembranelogo from "@/assets/dembrane-logo-hq.png";
import SystemMessage from "./SystemMessage";

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
							<img
								src={dembranelogo}
								alt="Dembrane Logo"
								width={20}
								className="my-4"
							/>
						</div>
					</Group>
				}
				className={clsx(
					"border-0 !rounded-br-none py-5 px-0 md:py-7",
					className,
				)}
			/>
		);
	}
	return null;
};

export default SpikeMessage;
