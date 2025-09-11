import { Outlet } from "react-router";
import { I18nProvider } from "./I18nProvider";

export const LanguageLayout = () => {
  return (
    <I18nProvider>
      <Outlet />
    </I18nProvider>
  );
};
