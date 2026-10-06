import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Menu } from "@mantine/core";
import {
	ArrowSquareOutIcon,
	CaretDownIcon,
	StopIcon,
} from "@phosphor-icons/react";
import type { LiveBooking, LiveHours } from "@/components/popcorn/hooks";
import { testId } from "@/lib/testUtils";
import classes from "./LiveButton.module.css";
import { useLiveChoices } from "./LiveButton";

/**
 * The Present split button. The main part opens the room screen and starts
 * the analysis for the hours chosen (default 8), unless it is already live or
 * booked. The chevron holds the same pieces as the Analyse button: Ready by,
 * Stay live for, and Stop live while live or Cancel while booked.
 */
export function PresentButton({
	live,
	pending,
	opening = false,
	booking = null,
	onPresent,
	onGoLive,
	onReadyBy,
	onStop,
}: {
	live: boolean;
	pending: boolean;
	/** The presentation is still being prepared. */
	opening?: boolean;
	booking?: LiveBooking | null;
	/** Opens the room screen; going live, when it should, is the caller's. */
	onPresent: (hours: LiveHours) => void;
	/** While live: live again for the hours from now. */
	onGoLive: (hours: LiveHours) => void;
	onReadyBy: (hours: LiveHours, readyBy: Date) => void;
	/** Stops live, or cancels a booked start. */
	onStop: () => void;
}) {
	const { hours, opened, readyByField, setOpened, stayLiveFor } =
		useLiveChoices({ booking, live, onGoLive, onReadyBy });
	const booked = !live && !!booking;

	return (
		<div className={classes.split} {...testId("present-split")}>
			<Button
				variant="filled"
				className={classes.main}
				leftSection={<ArrowSquareOutIcon size={20} />}
				loading={opening}
				onClick={() => onPresent(hours)}
				{...testId("present-open")}
			>
				<Trans>Present</Trans>
			</Button>
			<Menu
				position="bottom-end"
				opened={opened}
				onChange={setOpened}
				closeOnItemClick
			>
				<Menu.Target>
					<Button
						variant="filled"
						className={classes.more}
						loading={pending}
						aria-label={t`More ways to present`}
						{...testId("present-more")}
					>
						<CaretDownIcon size={16} />
					</Button>
				</Menu.Target>
				<Menu.Dropdown>
					{live ? (
						<>
							{stayLiveFor}
							<Menu.Divider />
							<Menu.Item
								color="red"
								leftSection={<StopIcon size={16} />}
								onClick={onStop}
								{...testId("live-stop")}
							>
								<Trans>Stop live</Trans>
							</Menu.Item>
						</>
					) : (
						<>
							{readyByField}
							<Menu.Divider />
							{stayLiveFor}
							{booked && (
								<>
									<Menu.Divider />
									<Menu.Item
										c="dimmed"
										onClick={onStop}
										{...testId("live-cancel-booking")}
									>
										<Trans>Cancel</Trans>
									</Menu.Item>
								</>
							)}
						</>
					)}
				</Menu.Dropdown>
			</Menu>
		</div>
	);
}
