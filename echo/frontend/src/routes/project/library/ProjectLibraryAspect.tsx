import { Trans } from "@lingui/react/macro";
import {
	Container,
	Divider,
	Group,
	LoadingOverlay,
	Skeleton,
	Stack,
	Title,
} from "@mantine/core";
import { useParams } from "react-router";
import { useCopyAspect } from "@/components/aspect/hooks/useCopyAspect";
import { Breadcrumbs } from "@/components/common/Breadcrumbs";
import { CopyIconButton } from "@/components/common/CopyIconButton";
import { Markdown } from "@/components/common/Markdown";
import { useAspectById } from "@/components/library/hooks";
import { useProjectById } from "@/components/project/hooks";
import { sanitizeImageUrl } from "@/lib/utils";
import { Quote } from "../../../components/quote/Quote";

export const ProjectLibraryAspect = () => {
	const { projectId, viewId, aspectId } = useParams();

	const { data: aspect, isLoading } = useAspectById(
		projectId ?? "",
		aspectId ?? "",
	);

	const { copyAspect, copied } = useCopyAspect();

	const project = useProjectById({
		projectId: projectId ?? "",
		query: {
			fields: ["image_generation_model"],
		},
	});

	return (
		<Stack className="relative px-4 py-6">
			<Breadcrumbs
				items={[
					{
						label: <Trans>Library</Trans>,
						link: `/projects/${projectId}/library`,
					},
					{
						label: <Trans>View</Trans>,
						link: `/projects/${projectId}/library/views/${viewId}`,
					},
					{
						label: <Trans>Aspect</Trans>,
					},
				]}
			/>
			<Divider />

			<Stack gap="md" className="relative">
				<LoadingOverlay visible={isLoading} />
				{project.data?.image_generation_model !== "PLACEHOLDER" && (
					<img
						src={sanitizeImageUrl(aspect?.image_url ?? "/placeholder.png")}
						alt={aspect?.name ?? ""}
						className="h-[400px] w-full object-cover"
					/>
				)}
				<Container size="sm">
					<Stack>
						<Group>
							<Title order={1}>{aspect?.name}</Title>
							<CopyIconButton
								size={24}
								onCopy={() => copyAspect(aspectId ?? "")}
								copied={copied}
							/>
						</Group>
						<Markdown
							content={aspect?.long_summary ?? ""}
							className="!max-w-full"
						/>
						{!isLoading ? (
							<>
								{aspect?.aspect_segment?.length &&
									aspect?.aspect_segment?.length > 0 && (
										<Title order={2}>
											<Trans>Insights</Trans>
										</Title>
									)}
								{aspect?.aspect_segment?.map((segment) => (
									<Quote
										key={(segment as AspectSegment).id}
										data={segment as AspectSegment}
									/>
								))}
							</>
						) : (
							<Skeleton height={100} />
						)}
					</Stack>
				</Container>
			</Stack>
		</Stack>
	);
};
