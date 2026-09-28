import { Paper, Text } from "@mantine/core";
import clsx from "clsx";
import type { ReactNode } from "react";
import { Markdown } from "@/components/common/Markdown";
import { testId } from "@/lib/testUtils";

const SystemMessage = ({
	markdown,
	title,
	className,
	dataTestId,
}: {
	markdown?: string;
	title?: ReactNode;
	className?: string;
	dataTestId?: string;
}) => {
	return (
		<div className="flex justify-start">
			<Paper
				bg="transparent"
				className={clsx(
					"w-full rounded-t-xl rounded-br-xl border border-slate-200 p-4",
					className,
				)}
				{...(dataTestId ? testId(dataTestId) : {})}
			>
				<div className="flex flex-col items-start gap-4 md:flex-row">
					{title && <div className="flex-shrink-0">{title}</div>}
					<Text className="prose text-sm">
						<Markdown content={markdown ?? ""} />
					</Text>
				</div>
			</Paper>
		</div>
	);
};

export default SystemMessage;
