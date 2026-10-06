import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Skeleton, Stack, Switch, Text } from "@mantine/core";
import { PencilSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import {
	type PopcornDetail,
	usePopcornSettingsMutation,
} from "@/components/popcorn/hooks";
import { useProjectById } from "@/components/project/hooks";
import { testId } from "@/lib/testUtils";
import { hostGuideText } from "@/routes/project/HostGuidePage";

/**
 * Present's host guide screen: the code to take part and the host guide's
 * steps, after the data policy. The words are edited in one place, the host
 * guide, so the screen and the printout say the same; this copies them in.
 */
export function HostGuideSettings({
	projectId,
	presentation,
}: {
	projectId: string;
	presentation: PopcornDetail;
}) {
	const { workspaceId = "" } = useParams();
	const save = usePopcornSettingsMutation(projectId, presentation.id);
	const project = useProjectById({
		projectId,
		query: {
			fields: [
				"id",
				"language",
				"host_guide",
				"is_conversation_allowed",
				"default_conversation_ask_for_participant_name",
			],
		},
	});
	const guide = presentation.settings.guide;
	const words = project.data ? hostGuideText(project.data) : null;
	// Trimmed and cut as the API stores them, so a copy reads back the same.
	const title = words?.title.trim().slice(0, 160) ?? "";
	const steps = words?.steps.join("\n").trim().slice(0, 1200) ?? "";
	// The host guide changed since the screen copied it: copy it again.
	const stale =
		!!guide?.enabled &&
		!!words &&
		(guide.title !== title || guide.steps !== steps);
	const { mutate, isPending } = save;
	const copied = useRef("");
	useEffect(() => {
		const next = `${title}\n${steps}`;
		if (!stale || copied.current === next) return;
		copied.current = next;
		mutate({ guide: { steps, title } });
	}, [stale, mutate, steps, title]);

	if (!project.data || !words) return <Skeleton height={60} />;
	if (!project.data.is_conversation_allowed)
		return (
			<Text size="sm" c="dimmed">
				<Trans>
					The host guide screen shows the code to take part. Turn on
					participation in the portal editor to use it.
				</Trans>
			</Text>
		);
	return (
		<Stack gap="md">
			<Switch
				label={t`Show the host guide`}
				description={t`A screen after the data policy with the code to take part and the steps from your host guide.`}
				checked={!!guide?.enabled}
				disabled={isPending}
				onChange={(event) =>
					mutate({
						guide: { enabled: event.currentTarget.checked, steps, title },
					})
				}
				{...testId("present-guide-toggle")}
			/>
			{guide?.enabled && (
				<Stack gap="xs">
					<Text>{title}</Text>
					{words.steps.map((step, index) => (
						<Text key={step} size="sm">
							<Text span c="dimmed" size="sm">
								{index + 1}
							</Text>{" "}
							{step}
						</Text>
					))}
				</Stack>
			)}
			<Button
				component={I18nLink}
				to={`/w/${workspaceId}/projects/${projectId}/host-guide`}
				target="_blank"
				leftSection={<PencilSimpleIcon size={20} />}
				className="self-start"
			>
				<Trans>Edit the host guide</Trans>
			</Button>
		</Stack>
	);
}
