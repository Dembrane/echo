import { Outlet, useLocation } from "react-router-dom";
import { useState } from "react";
import { Group, ActionIcon, Box } from "@mantine/core";
import useSessionStorageState from "use-session-storage-state";
import { IconSettings } from "@tabler/icons-react";

import { Logo } from "../common/Logo";
import { I18nProvider } from "./I18nProvider";

import { t } from "@lingui/core/macro";

import { ParticipantSettingsModal } from "../participant/ParticipantSettingsModal";

const ParticipantHeader = () => {
  const [loadingFinished] = useSessionStorageState("loadingFinished", {
    defaultValue: true,
  });

  if (!loadingFinished) {
    return null;
  }

  return (
    <Group component="header" justify="center" className="py-2 shadow-sm">
      <Logo hideTitle h="64px" />
    </Group>
  );
};

export const ParticipantLayout = () => {
  const { pathname } = useLocation();
  const isReportPage = pathname.includes("report");
  const isOnboardingPage = pathname.includes("start");
  const [settingsModalOpened, setSettingsModalOpened] = useState(false);

  if (isReportPage) {
    return (
      <I18nProvider>
        <main className="relative min-h-dvh">
          <Outlet />
        </main>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider>
      <ParticipantSettingsModal
        opened={settingsModalOpened}
        onClose={() => setSettingsModalOpened(false)}
      />

      <main className="relative !h-dvh overflow-y-auto">
        <div className="flex h-full flex-col">
          <ParticipantHeader />
          {!isOnboardingPage && (
            <Box className="absolute right-4 top-5 z-20">
              <ActionIcon
                size="lg"
                variant="transparent"
                onClick={() => setSettingsModalOpened(true)}
                title={t`Settings`}
              >
                <IconSettings size={24} color="gray" />
              </ActionIcon>
            </Box>
          )}
          <main className="relative grow">
            <Outlet />
          </main>
        </div>
      </main>
    </I18nProvider>
  );
};
