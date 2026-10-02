import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Avatar,
	Container,
	Group,
	Loader,
	Paper,
	Progress,
	SimpleGrid,
	Stack,
	Text,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { nextTaskText } from "../format";
import { summarise, useTasksSummary } from "../help/tasksSummary";
import { AccountsI18n } from "../i18n";

/**
 * Where "Tasks" in the Help menu leads when the caller has tasks in more than one
 * organisation: one card per org with its progress and next task, each opening that
 * org's account page.
 */
export const AccountPickerRoute = () => (
	<AccountsI18n>
		<Picker />
	</AccountsI18n>
);

function Picker() {
	useDocumentTitle(t`Tasks | dembrane`);
	const navigate = useI18nNavigate();
	const { data, isLoading } = useTasksSummary();
	const { orgs } = summarise(data);
	if (isLoading) return <Loader m="xl" size="sm" />;
	return (
		<Container size="md" px={{ base: "md", sm: "lg" }} py="xl">
			<Stack gap="lg">
				<Stack gap={2}>
					<Title order={3}>
						<Trans>Tasks</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>
							What each of your organisations still has to do for dembrane.
						</Trans>
					</Text>
				</Stack>
				{orgs.length === 0 && (
					<Text size="sm" c="dimmed">
						<Trans>Nothing to do right now.</Trans>
					</Text>
				)}
				<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
					{orgs.map((org) => (
						<UnstyledButton
							key={org.org_id}
							onClick={() => navigate(`/o/${org.org_id}/account`)}
							data-testid="picker-org"
						>
							<Paper withBorder radius="md" p="md" h="100%">
								<Stack gap="sm">
									<Group gap="sm" wrap="nowrap">
										<Avatar src={org.logo_url} radius="sm" color="gray">
											{org.name.slice(0, 1)}
										</Avatar>
										<Stack gap={0} style={{ minWidth: 0 }}>
											<Text truncate>{org.name}</Text>
											<Text size="xs" c="dimmed">
												<Trans>
													{org.tasks_done} of {org.tasks_total} done
												</Trans>
											</Text>
										</Stack>
									</Group>
									<Progress
										value={(org.tasks_done / org.tasks_total) * 100}
										size="sm"
										aria-label={t`Progress`}
									/>
									<Text
										size="sm"
										c={nextTaskText(org) ? undefined : "dimmed"}
										lineClamp={2}
									>
										{nextTaskText(org) ? (
											<Trans>Next: {nextTaskText(org)}</Trans>
										) : (
											<Trans>Waiting on dembrane</Trans>
										)}
									</Text>
								</Stack>
							</Paper>
						</UnstyledButton>
					))}
				</SimpleGrid>
			</Stack>
		</Container>
	);
}
