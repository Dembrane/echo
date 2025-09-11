import { Box } from "@mantine/core";
import { Toaster } from "../common/Toaster";
import { Outlet } from "react-router";
import { PropsWithChildren } from "react";
import { Header } from "./Header";
import { ErrorBoundary } from "../error/ErrorBoundary";

export const BaseLayout = ({ children }: PropsWithChildren) => {
  return (
    <Box className="min-h-screen">
      <Box className="fixed top-0 z-10 w-full">
        <Header />
      </Box>

      <ErrorBoundary>
        <main className="h-base-layout-height pt-base-layout-padding w-full">
          <Outlet />
          {children}
        </main>
      </ErrorBoundary>

      <Toaster />
    </Box>
  );
};
