import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Button,
	Container,
	Divider,
	Group,
	Loader,
	LoadingOverlay,
	Modal,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconCalendarEvent,
	IconInfoCircle,
	IconLock,
	IconPlus,
} from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import { useParams } from "react-router";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { CloseableAlert } from "@/components/common/ClosableAlert";
import { useConversationsByProjectId } from "@/components/conversation/hooks";
import {
	useGenerateProjectLibraryMutation,
	useProjectViews,
} from "@/components/library/hooks";
import {
	useLatestProjectAnalysisRunByProjectId,
	useProjectById,
} from "@/components/project/hooks";
import { ProjectAnalysisRunStatus } from "@/components/project/ProjectAnalysisRunStatus";
import { CreateView } from "@/components/view/CreateViewForm";
import { ViewExpandedCard } from "@/components/view/View";
import { useLanguage } from "@/hooks/useLanguage";
import { Icons } from "@/icons";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { SalesLinks } from "@/lib/links";
import { DummyViews } from "../../../components/view/DummyViews";

export const ProjectLibraryRoute = () => {
	const { projectId } = useParams<{ projectId: string }>();

	const { iso639_1 } = useLanguage();

	const viewsQuery = useProjectViews(projectId ?? "");
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: {
			fields: ["is_enhanced_audio_processing_enabled"],
		},
	});
	const conversationsQuery = useConversationsByProjectId(
		projectId ?? "",
		false,
	);
	const requestProjectLibraryMutation = useGenerateProjectLibraryMutation();

	const latestRunQuery = useLatestProjectAnalysisRunByProjectId(
		projectId ?? "",
	);

	const latestRun = latestRunQuery.data ?? null;

	const [opened, { toggle, close }] = useDisclosure(false);

	const isLibraryEnabled =
		projectQuery.data?.is_enhanced_audio_processing_enabled ?? false;

	// To show number of ready and processing conversations
	const finishedConversationsCount =
		conversationsQuery.data?.filter(
			(conversation) => conversation.is_audio_processing_finished === true,
		).length ?? 0;

	const unfinishedConversationsCount =
		conversationsQuery.data?.filter(
			(conversation) => conversation.is_audio_processing_finished === false,
		).length ?? 0;

	if (conversationsQuery.isLoading) {
		return (
			<Container>
				<Stack className="relative h-[400px] px-2 py-6">
					<LoadingOverlay visible />
				</Stack>
			</Container>
		);
	}

	const viewsExist = viewsQuery?.data && viewsQuery.data.length > 0;

	const handleCreateLibrary = async () => {
		if (
			window.confirm(
				t`Are you sure you want to generate the library? This will take a while and overwrite your current views and insights.`,
			)
		) {
			requestProjectLibraryMutation.mutate({
				language: iso639_1,
				projectId: projectId ?? "",
			});
		}
	};

	const contactSales = () => {
		if (!isLibraryEnabled) {
			try {
				analytics.trackEvent(events.LIBRARY_CONTACT_SALES);
			} catch (error) {
				console.warn("Analytics tracking failed:", error);
			}
			window.open(SalesLinks.AUTO_SELECT_CONTACT, "_blank");
		}
	};

	return (
		<Stack className="relative px-4 py-6">
			<Group justify="space-between">
				<Breadcrumbs
					items={[
						{
							label: (
								<Title order={1}>
									<Trans id="library.title">Library</Trans>
								</Title>
							),
						},
					]}
				/>
				<Group gap="xl">
					{!isLibraryEnabled && (
						<Button onClick={contactSales} rightSection={<IconCalendarEvent />}>
							<Trans id="library.request.access">Request Access</Trans>
						</Button>
					)}

					{!latestRun && (
						<Tooltip
							label={
								requestProjectLibraryMutation.isPending
									? t`Library creation is in progress`
									: !isLibraryEnabled
										? t`Not available`
										: conversationsQuery.data?.length === 0
											? t`No conversations available to create library`
											: // : latestRun?.processing_status === "PROCESSING"
												//   ? t`Library is currently being processed`
												null
							}
							disabled={
								!(
									(
										requestProjectLibraryMutation.isPending ||
										!isLibraryEnabled ||
										conversationsQuery.data?.length === 0
									)
									// ||
									// latestRun?.processing_status === "PROCESSING"
								)
							}
						>
							<Button
								rightSection={!isLibraryEnabled ? <IconLock /> : <IconPlus />}
								onClick={handleCreateLibrary}
								loading={
									requestProjectLibraryMutation.isPending ||
									requestProjectLibraryMutation.isSuccess
								}
								disabled={
									// TODO: this should really be a server-side check
									requestProjectLibraryMutation.isPending ||
									!isLibraryEnabled ||
									conversationsQuery.data?.length === 0 ||
									latestRunQuery.isFetching
									// ||
									// latestRun?.processing_status === "PROCESSING"
								}
							>
								<Trans id="library.create">Create Library</Trans>
							</Button>
						</Tooltip>
					)}
				</Group>
			</Group>

			<Divider />

			{isLibraryEnabled && (
				<ProjectAnalysisRunStatus projectId={projectId ?? ""} />
			)}

			{conversationsQuery.data?.length === 0 && (
				<CloseableAlert variant="light" icon={<IconInfoCircle />}>
					<Text>
						<Trans id="library.no.conversations">
							No conversations available to create library. Please add some
							conversations to get started.
						</Trans>
					</Text>
				</CloseableAlert>
			)}

			<Trans id="library.description">
				This is your project library. Create views to analyse your entire
				project at once.
			</Trans>

			{!isLibraryEnabled && (
				<CloseableAlert color="orange" variant="light">
					<Trans id="library.not.available.message">
						It looks like the library is not available for your account. Please
						request access to unlock this feature.
					</Trans>
				</CloseableAlert>
			)}

			{!latestRun &&
				isLibraryEnabled &&
				conversationsQuery.data?.length &&
				conversationsQuery.data?.length > 0 && (
					<CloseableAlert>
						<Plural
							id="library.conversations.to.be.analyzed"
							value={finishedConversationsCount}
							one="Currently # conversation is ready to be analyzed."
							other="Currently # conversations are ready to be analyzed."
						/>{" "}
						<Trans id="library.conversations.still.processing">
							{unfinishedConversationsCount} still processing.
						</Trans>
						<Trans id="library.generate.duration.message">
							{" "}
							Generating library can take up to an hour.
						</Trans>
					</CloseableAlert>
				)}

			{latestRun && !viewsExist && isLibraryEnabled && (
				<Group align="center" gap="md" my="sm">
					<Loader size="xs" />
					<Trans id="library.processing.request">
						Please wait while we process your request. You requested to create
						the library on{" "}
						{formatRelative(
							new Date(latestRun.created_at ?? new Date()),
							new Date(),
						)}
					</Trans>
				</Group>
			)}

			<Group justify="space-between">
				<Title order={2}>
					<Trans id="library.views.title">Your Views</Trans>
				</Title>
				{isLibraryEnabled && (
					<Button
						rightSection={<IconPlus />}
						onClick={toggle}
						disabled={
							!(
								latestRun
								// && latestRun.processing_status === "DONE"
							)
						}
					>
						<Trans id="library.create.view">Create View</Trans>
					</Button>
				)}
			</Group>

			<Modal
				opened={opened}
				onClose={close}
				title={
					<Group>
						<Icons.View />
						<Text fw={500} size="lg">
							<Trans id="library.create.view.modal.title">
								Create new view
							</Trans>
						</Text>
					</Group>
				}
				withinPortal
				size="lg"
			>
				<CreateView projectId={projectId ?? ""} />
			</Modal>

			<Stack>
				{!viewsExist && <DummyViews />}
				{viewsQuery.data?.map((v) => (
					<ViewExpandedCard
						key={v.id}
						data={v}
						isLibraryEnabled={isLibraryEnabled}
					/>
				))}
			</Stack>
		</Stack>
	);
};
