import { Trans } from "@lingui/react/macro";
import {
	Divider,
	Group,
	LoadingOverlay,
	Paper,
	SimpleGrid,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useParams } from "react-router";
import { AspectCard } from "@/components/aspect/AspectCard";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { CopyIconButton } from "@/components/common/CopyIconButton";
import { Markdown } from "@/components/common/Markdown";
import { useViewById } from "@/components/library/hooks";
import { useCopyView } from "@/components/view/hooks/useCopyView";
import { Icons } from "@/icons";

export const ProjectLibraryView = () => {
	const { projectId, viewId } = useParams();

	const { copyView, copied } = useCopyView();
	const view = useViewById(projectId ?? "", viewId ?? "");

	return (
		<Stack className="min-h-dvh px-4 py-6">
			<Breadcrumbs
				items={[
					{
						label: <Trans>Library</Trans>,
						link: `/projects/${projectId}/library`,
					},
					{
						label: <Trans>View</Trans>,
					},
				]}
			/>
			<Divider />
			<LoadingOverlay visible={view.isLoading} />
			<Group>
				<Title order={1}>{view.data?.name}</Title>
				<CopyIconButton
					onCopy={() => copyView(viewId ?? "")}
					copied={copied}
					size={24}
				/>
			</Group>
			<Markdown content={view.data?.summary ?? ""} />
			<Paper p="md">
				<Stack>
					<Group c="gray">
						<Icons.Aspect />
						<Text className="font-semibold">
							<Trans>Aspects</Trans>
						</Text>
					</Group>

					<SimpleGrid
						cols={{
							md: 3,
							sm: 2,
							xl: 4,
						}}
						spacing="md"
					>
						{view.data?.aspects?.map(
							(aspect) =>
								aspect && (
									<AspectCard
										key={(aspect as Aspect).id}
										data={aspect as Aspect}
										className="h-full w-full"
									/>
								),
						)}
					</SimpleGrid>
				</Stack>
			</Paper>
		</Stack>
	);
};
