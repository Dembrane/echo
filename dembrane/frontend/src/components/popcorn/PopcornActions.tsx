import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	ArrowCounterClockwiseIcon,
	ArrowsClockwiseIcon,
	ProjectorScreenIcon,
} from "@phosphor-icons/react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import {
	liveBooking,
	type PopcornDetail,
	popcornPresenterUrl,
	usePopcornLiveMutation,
	usePopcornStopLiveMutation,
	useRefreshPopcornMutation,
	useRerunPopcornMutation,
} from "@/components/popcorn/hooks";
import { LiveButton } from "@/components/sharing/LiveButton";
import { testId } from "@/lib/testUtils";

// What a host can do with a session: open the wall, read once, read from
// nothing, or go live for a while, now or ready by a time.
export function PopcornActions({
	projectId,
	popcorn,
}: {
	projectId: string;
	popcorn: PopcornDetail;
}) {
	const refresh = useRefreshPopcornMutation(projectId, popcorn.id);
	const rerun = useRerunPopcornMutation(projectId, popcorn.id);
	const live = usePopcornLiveMutation(projectId, popcorn.id);
	const stopLive = usePopcornStopLiveMutation(projectId, popcorn.id);
	const [rerunOpened, rerunModal] = useDisclosure(false);
	const isLive = popcorn.loop?.mode === "live";
	const booking = liveBooking(popcorn.loop);

	return (
		<Group gap="xs" wrap="wrap" {...testId("popcorn-actions")}>
			<Button
				variant="filled"
				component="a"
				href={popcornPresenterUrl(popcorn.id)}
				target="_blank"
				rel="noopener noreferrer"
				leftSection={<ProjectorScreenIcon size={20} />}
				{...testId("popcorn-open-presenter")}
			>
				<Trans>Open presenter view</Trans>
			</Button>
			<Button
				leftSection={<ArrowsClockwiseIcon size={20} />}
				loading={refresh.isPending}
				onClick={() => refresh.mutate()}
				{...testId("popcorn-refresh-button")}
			>
				<Trans>Refresh</Trans>
			</Button>
			<Button
				leftSection={<ArrowCounterClockwiseIcon size={20} />}
				onClick={rerunModal.open}
				{...testId("popcorn-rerun-button")}
			>
				<Trans>Regenerate</Trans>
			</Button>
			<LiveButton
				live={isLive}
				booking={booking}
				pending={live.isPending || stopLive.isPending}
				onGoLive={(hours) => live.mutate({ hours })}
				onReadyBy={(hours, readyBy) => live.mutate({ hours, readyBy })}
				onStop={() => stopLive.mutate()}
			/>
			<ConfirmModal
				opened={rerunOpened}
				onClose={rerunModal.close}
				onConfirm={() =>
					rerun.mutate(undefined, { onSuccess: rerunModal.close })
				}
				title={t`Regenerate popcorn?`}
				message={
					<Trans>
						This replaces every popcorn, tension and stakeholder on the screen
						and reads all conversations again. Earlier runs are saved in the
						history.
					</Trans>
				}
				confirmLabel={<Trans>Regenerate</Trans>}
				confirmColor="red"
				loading={rerun.isPending}
				{...testId("popcorn-rerun-modal")}
			/>
		</Group>
	);
}
