import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Menu } from "@mantine/core";
import { BroadcastIcon, CaretDownIcon } from "@phosphor-icons/react";
import type { LiveHours } from "@/components/popcorn/hooks";
import { testId } from "@/lib/testUtils";

/**
 * Go live for a while, or stop. Choosing how long is the decision, so it is
 * one click; Stop live takes Go live's place and is a plain secondary, since
 * stopping is reversible and red belongs to the live state, not the button.
 */
export function LiveButton({
	live,
	pending,
	onGoLive,
	onStop,
}: {
	live: boolean;
	pending: boolean;
	onGoLive: (hours: LiveHours) => void;
	onStop: () => void;
}) {
	if (live)
		return (
			<Button
				leftSection={<BroadcastIcon size={20} />}
				loading={pending}
				onClick={onStop}
				{...testId("live-stop")}
			>
				<Trans>Stop live</Trans>
			</Button>
		);
	const hours: { value: LiveHours; label: string }[] = [
		{ label: t`1 hour`, value: 1 },
		{ label: t`8 hours`, value: 8 },
		{ label: t`24 hours`, value: 24 },
	];
	return (
		<Menu position="bottom-start">
			<Menu.Target>
				<Button
					leftSection={<BroadcastIcon size={20} />}
					rightSection={<CaretDownIcon size={16} />}
					loading={pending}
					{...testId("live-go")}
				>
					<Trans>Go live</Trans>
				</Button>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Label>
					<Trans>Stay live for</Trans>
				</Menu.Label>
				{hours.map((option) => (
					<Menu.Item
						key={option.value}
						onClick={() => onGoLive(option.value)}
						{...testId(`live-${option.value}h`)}
					>
						{option.label}
					</Menu.Item>
				))}
			</Menu.Dropdown>
		</Menu>
	);
}
