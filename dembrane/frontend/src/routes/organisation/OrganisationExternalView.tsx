import { t } from "@lingui/core/macro";
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
	const { workspaces, setWorkspace } = useWorkspace();
	const navigate = useNavigate();

	// Sync context first so workspace-scoped queries don't lag.
	const openWorkspace = (id: string) => {
		setWorkspace(id);
		navigate(`/w/${id}/home`);
	};

	const orgWorkspaces = workspaces.filter((w) => w.org_id === organisationId);
	const first = orgWorkspaces[0];
	const orgName = first?.org_name ?? t`Organisation`;
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
					<Stack gap="xs">
						<Group gap="sm" align="center">
							<Title order={2}>{orgName}</Title>
							<Badge variant="light" color="gray">
								<Trans>External</Trans>
							</Badge>
						</Group>
						<Text size="sm" c="dimmed">
							<Trans>
								You're an external collaborator in this organisation. Open one
								of the workspaces shared with you below.
							</Trans>
						</Text>
					</Stack>
				</Group>

				<Stack gap="sm">
					<Title order={5}>
						<Trans>Workspaces shared with you</Trans>
					</Title>
					{orgWorkspaces.length === 0 ? (
						<Text size="sm" c="dimmed">
							<Trans>
								No workspaces from this organisation are shared with you right
								now.
							</Trans>
						</Text>
					) : (
						orgWorkspaces.map((ws) => (
							<Paper
								key={ws.id}
								p="md"
								withBorder={false}
								className="app-do"
								onClick={() => openWorkspace(ws.id)}
							>
								<Group justify="space-between" align="center" wrap="nowrap">
									<Stack gap="xs">
										<Text>{ws.name}</Text>
										<Group gap="xs">
											<Text size="xs" c="dimmed">
												{displayRole(ws.role)}
											</Text>
											<Text size="xs" c="dimmed">
												·
											</Text>
											<Text size="xs" c="dimmed">
												{ws.project_count} <Trans>projects</Trans>
											</Text>
										</Group>
									</Stack>
									<Button
										size="xs"
										onClick={(e) => {
											e.stopPropagation();
											openWorkspace(ws.id);
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
						Need more access? Ask the person who invited you to add you to the
						organisation or another workspace.
					</Trans>
				</Text>
			</Stack>
		</Container>
	);
};
