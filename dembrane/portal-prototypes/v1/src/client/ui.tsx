import { Button, Empty, Text } from "@cloudflare/kumo";
import { GearSixIcon, MoonIcon, QuestionIcon, SunIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";

function ModeToggle() {
  const [mode, setMode] = useState(() => localStorage.getItem("theme") || "light");

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

/** For a project ID that isn't one, or a project that doesn't exist. */
export function ProjectNotFound() {
  return (
    <Shell title="Not found">
      <Empty
        icon={<QuestionIcon size={48} />}
        title="Project not found"
        description="Check the link you were given."
      />
    </Shell>
  );
}

/** The header and centered column every page shares. */
export function Shell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-full bg-kumo-base flex flex-col">
      <header className="border-b border-kumo-line px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <GearSixIcon size={20} weight="bold" className="text-kumo-accent shrink-0" />
          <Text size="sm" bold truncate>
            {title}
          </Text>
        </div>
        <div className="flex items-center gap-2">
          {actions}
          <ModeToggle />
        </div>
      </header>
      <main className="flex-1 p-4 max-w-2xl mx-auto w-full flex flex-col gap-4">{children}</main>
    </div>
  );
}
