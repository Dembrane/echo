import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Badge,
	Group,
	Paper,
	Skeleton,
	Stack,
	Tooltip,
} from "@mantine/core";
import {
	IconFileText,
	IconPlayerPause,
	IconPlayerPlay,
	IconPlayerSkipBack,
	IconPlayerSkipForward,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";

const seekAbs = (
	audioRef?: React.RefObject<HTMLAudioElement>,
	delta: number = 0,
) => {
	if (!audioRef?.current) return;

	const currentTime = audioRef.current.currentTime;
	audioRef.current.currentTime = Math.max(
		// 0,
		// should always be less than duration?
		// deciding to not do this because sometimes the metadata is incorrect
		// Math.min(currentTime + delta, audioRef.current.duration),

		0, // atleast 0
		currentTime + delta,
	);
};

export const ConversationAudioPlayer = (props: {
	isLoading: boolean;
	isError: string;
	audioSrc: string;
	ref?: React.RefObject<HTMLAudioElement>;
	onLoaded: () => void;
	onPlay: () => void;
	onPause: () => void;
}) => {
	const [isPlaying, setIsPlaying] = useState(false);

	useEffect(() => {
		props.ref?.current?.addEventListener("play", () => setIsPlaying(true));
		props.ref?.current?.addEventListener("pause", () => setIsPlaying(false));
	}, [props.ref]);

	return (
		<Paper p="md" className="sticky top-2 z-40 bg-white shadow-lg" withBorder>
			<Stack gap="xs">
				<Group justify="space-between" align="center">
					<Group gap="xs">
						<Badge
							variant="light"
							color="blue"
							leftSection={<IconFileText size={12} />}
						>
							<Trans>Conversation Audio</Trans>
						</Badge>
					</Group>
				</Group>

				{props.isLoading && <Skeleton height={40} radius="sm" />}
				{props.isError && (
					<Alert color="red" variant="light">
						<Trans>We couldn't load the audio. Please try again later.</Trans>
					</Alert>
				)}
				{!!props.audioSrc && (
					<>
						{/** biome-ignore lint/a11y/useMediaCaption: <transcript is provided to the user> */}
						<audio
							ref={props.ref}
							src={props.audioSrc}
							key={props.audioSrc}
							className="w-full h-10"
							controls
							onLoadedMetadata={props.onLoaded}
							onPlay={props.onPlay}
							onPause={props.onPause}
							preload="metadata"
						/>

						<Group gap="xs" justify="flex-end">
							<Tooltip label={t`-5s`}>
								<ActionIcon
									variant="light"
									onClick={() => seekAbs(props.ref, -5)}
								>
									<IconPlayerSkipBack size={16} />
								</ActionIcon>
							</Tooltip>
							<ActionIcon
								variant="light"
								onClick={() => {
									if (!props.ref?.current) return;

									if (props.ref.current.paused) {
										props.ref.current.play();
										props.onPlay();
									} else {
										props.ref.current.pause();
										props.onPause();
									}
								}}
							>
								{isPlaying ? (
									<IconPlayerPause size={16} />
								) : (
									<IconPlayerPlay size={16} />
								)}
							</ActionIcon>
							<Tooltip label={t`+5s`}>
								<ActionIcon
									variant="light"
									onClick={() =>
										seekAbs((audioRef.current?.currentTime || 0) + 5)
									}
								>
									<IconPlayerSkipForward size={16} />
								</ActionIcon>
							</Tooltip>
						</Group>
					</>
				)}
			</Stack>
		</Paper>
	);
};
