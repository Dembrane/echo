import "@mantine/core/styles.css";
import "@/index.css";

import { MantineProvider, Stack } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { IconContext } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { OrgAiProviderPanel } from "@/components/ai-provider/OrgAiProviderPanel";
import { Toaster } from "@/components/common/Toaster";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { PageContainer } from "@/components/layout/PageContainer";
import { ProjectAiProvider } from "@/components/project/advanced/ProjectAiProvider";
import { SettingsSectionLevel } from "@/components/project/ProjectSettingsSection";
import { AccountsI18n } from "@/features/accounts/i18n";
import { AiProviderSection } from "@/features/accounts/staff/AiProviderSection";
import { cssVariablesResolver, theme } from "@/theme";

// The AI provider screens outside the signed-in shell, for screenshots: the organisation's page,
// a project's Advanced settings section, and the staff account card's section. ?view= picks
// one (org | project | staff); the spec answers the API with the service's own responses
// (aiProviderFixtures.ts).
const view = new URLSearchParams(window.location.search).get("view") ?? "org";
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const Screen = () => {
	if (view === "project")
		return (
			<SettingsSectionLevel.Provider value="card">
				<Stack gap="lg" p={{ base: "md", md: "lg" }} maw={1024}>
					<ProjectAiProvider projectId="p1" />
				</Stack>
			</SettingsSectionLevel.Provider>
		);
	if (view === "staff")
		return (
			<PageContainer width="md">
				<AiProviderSection orgId="o1" />
			</PageContainer>
		);
	return (
		<PageContainer>
			<OrgAiProviderPanel orgId="o1" />
		</PageContainer>
	);
};

createRoot(document.getElementById("root") as HTMLElement).render(
	<QueryClientProvider client={queryClient}>
		<MantineProvider
			defaultColorScheme="auto"
			theme={theme}
			cssVariablesResolver={cssVariablesResolver}
		>
			<IconContext.Provider value={{ weight: "light" }}>
				<I18nProvider>
					<AccountsI18n>
						<ModalsProvider>
							<MemoryRouter>
								<Screen />
							</MemoryRouter>
							<Toaster />
						</ModalsProvider>
					</AccountsI18n>
				</I18nProvider>
			</IconContext.Provider>
		</MantineProvider>
	</QueryClientProvider>,
);
