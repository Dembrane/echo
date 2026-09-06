import { t } from "@lingui/core/macro";
import { Container } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { AgentAccessSection } from "@/components/agent-access/AgentAccessSection";

// Reached from Help > Connect your agent. Its own page, not a settings
// section, so the beta surface stays out of the settings sidebar.
export const ConnectAgentRoute = () => {
	useDocumentTitle(t`Connect your agent | dembrane`);
	return (
		<Container size="xl" px="lg" py="xl">
			<AgentAccessSection />
		</Container>
	);
};
