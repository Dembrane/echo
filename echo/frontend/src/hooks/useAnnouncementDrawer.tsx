import useSessionStorageState from "use-session-storage-state";

export const useAnnouncementDrawer = () => {
  const [isOpen, setIsOpen] = useSessionStorageState(
    "announcement-drawer-open",
    {
      defaultValue: false,
    },
  );

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
