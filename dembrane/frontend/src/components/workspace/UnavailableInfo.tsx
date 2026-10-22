import { Tooltip } from "@mantine/core";
import { InfoIcon } from "@phosphor-icons/react";
import { testId } from "@/lib/testUtils";

// The "not on your plan" mark beside a capped create button, as on Create workspace.
export function UnavailableInfo({ label }: { label: string }) {
	return (
		<Tooltip label={label}>
			<InfoIcon
				size={16}
				color="var(--mantine-color-dimmed)"
				style={{ cursor: "help", flexShrink: 0 }}
				{...testId("unavailable-info")}
			/>
		</Tooltip>
	);
}
