import useSessionStorageState from "use-session-storage-state";
import { useEffect } from "react";

export const useAnnouncementDrawer = () => {
  const [isOpen, setIsOpen] = useSessionStorageState(
    "announcement-drawer-open",
    {
      defaultValue: false,
    },
  );

  // Reset drawer state on page reload
  useEffect(() => {
    setIsOpen(false);
  }, []);

  const open = () => setIsOpen(true);
  const close = () => setIsOpen(false);
  const toggle = () => setIsOpen(!isOpen);

  return {
    isOpen,
    setIsOpen,
    open,
    close,
    toggle,
  };
};
