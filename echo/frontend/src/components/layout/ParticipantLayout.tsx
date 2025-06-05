import { Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { Group } from "@mantine/core";
import useSessionStorageState from "use-session-storage-state";

import { Logo } from "../common/Logo";
import { I18nProvider } from "./I18nProvider";
import { cn } from "@/lib/utils";

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
      <main className="relative !h-dvh overflow-y-auto">
        <div className="flex h-full flex-col">
          <ParticipantHeader />
          <main className="relative grow">
            <Outlet />
          </main>
        </div>
      </main>
    </I18nProvider>
  );
};
