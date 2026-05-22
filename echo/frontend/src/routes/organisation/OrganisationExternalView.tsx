import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Container,
	Group,
	Image,
	Paper,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useNavigate } from "react-router";
import { useWorkspace } from "@/hooks/useWorkspace";
import { logoUrl as resolveLogoUrl } from "@/lib/avatar";
import { displayRole } from "@/lib/roles";

interface Props {
	organisationId: string;
}

// Shown when the user is an external collaborator in this organisation —
// they have at least one shared workspace but no org-level membership.
// The admin pages (members / usage / etc.) 403 for them, so we render a
// calmer "here's what you can do" page instead.
export const OrganisationExternalView = ({ organisationId }: Props) => {
	const { workspaces } = useWorkspace();
	const navigate = useNavigate();

	const orgWorkspaces = workspaces.filter((w) => w.org_id === organisationId);
	const first = orgWorkspaces[0];
	const orgName = first?.org_name ?? "Organisation";
	const orgLogo = first?.org_logo_url
		? resolveLogoUrl(first.org_logo_url)
		: null;

	return (
		<Container size="md" py="xl">
			<Stack gap="xl">
				<Group gap="md" align="center">
					{orgLogo ? (
						<Image
							src={orgLogo}
							alt=""
							w={56}
							h={56}
							radius="md"
							fit="contain"
						/>
					) : null}
					<Stack gap={4}>
						<Group gap="sm" align="center">
							<Title order={2} fw={500}>
								{orgName}
							</Title>
							<Badge variant="light" color="gray">
								<Trans>External</Trans>
							</Badge>
						</Group>
						<Text size="sm" c="dimmed">
							<Trans>
								You're an external collaborator in this organisation. Open
								one of the workspaces shared with you below.
							</Trans>
						</Text>
					</Stack>
				</Group>

				<Stack gap="sm">
					<Text size="xs" c="dimmed" tt="uppercase" style={{ letterSpacing: "0.04em" }}>
						<Trans>Workspaces shared with you</Trans>
					</Text>
					{orgWorkspaces.length === 0 ? (
						<Paper p="md" withBorder>
							<Text size="sm" c="dimmed">
								<Trans>
									No workspaces from this organisation are shared with you
									right now.
								</Trans>
							</Text>
						</Paper>
					) : (
						orgWorkspaces.map((ws) => (
							<Paper
								key={ws.id}
								p="md"
								withBorder
								className="cursor-pointer"
								onClick={() => navigate(`/w/${ws.id}/home`)}
							>
								<Group justify="space-between" align="center" wrap="nowrap">
									<Stack gap={2}>
										<Text fw={500}>{ws.name}</Text>
										<Group gap="xs">
											<Text size="xs" c="dimmed">
												{displayRole(ws.role)}
											</Text>
											<Text size="xs" c="dimmed">
												·
											</Text>
											<Text size="xs" c="dimmed">
												{ws.project_count}{" "}
												<Trans>projects</Trans>
											</Text>
										</Group>
									</Stack>
									<Button
										variant="light"
										size="xs"
										onClick={(e) => {
											e.stopPropagation();
											navigate(`/w/${ws.id}/home`);
										}}
									>
										<Trans>Open</Trans>
									</Button>
								</Group>
							</Paper>
						))
					)}
				</Stack>

				<Text size="xs" c="dimmed">
					<Trans>
						Need more access? Ask the person who invited you to add you to
						the organisation or another workspace.
					</Trans>
				</Text>
			</Stack>
		</Container>
	);
};
