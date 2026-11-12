import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { IconContext } from "@phosphor-icons/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { AppPreferencesProvider } from "@/hooks/useAppPreferences";
import { WhitelabelLogoProvider } from "@/hooks/useWhitelabelLogo";
import { cssVariablesResolver, theme } from "@/theme";
import { lockDown } from "./lockDown";
import { PortalPreviewApp } from "./PortalPreviewApp";

/**
 * Starts the portal's preview mode (ECHO-1060), in place of the participant router. main.tsx
 * loads this file only when config's IS_PORTAL_PREVIEW holds (a page in a frame at the
 * portal's …/:projectId/preview address, or any page in the dashboard's preview frame, by
 * its name), so it stays out of the portal's first load. Everything that could reach the world is taken
 * away before the first render.
 */
export function renderPreview(root: HTMLElement): void {
	lockDown();
	const segments = window.location.pathname.split("/").filter(Boolean);
	const projectId = segments[segments.length - 2] ?? "";
	ReactDOM.createRoot(root).render(
		<React.StrictMode>
			<MantineProvider
				theme={theme}
				cssVariablesResolver={cssVariablesResolver}
				defaultColorScheme="light"
			>
				<IconContext.Provider value={{ weight: "light" }}>
					<AppPreferencesProvider>
						<WhitelabelLogoProvider>
							<ModalsProvider>
								<PortalPreviewApp projectId={projectId} />
							</ModalsProvider>
						</WhitelabelLogoProvider>
					</AppPreferencesProvider>
				</IconContext.Provider>
			</MantineProvider>
		</React.StrictMode>,
	);
}
