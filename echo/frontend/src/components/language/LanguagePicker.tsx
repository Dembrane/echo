import { t } from "@lingui/core/macro";
import { SUPPORTED_LANGUAGES } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";
import { NativeSelect } from "@mantine/core";
import { ChangeEvent } from "react";
import { useLocation } from "react-router";

const data: Array<{
  language: (typeof SUPPORTED_LANGUAGES)[number];
  iso639_1: string;
  label: string;
  flag: string;
}> = [
  {
    language: "nl-NL",
    iso639_1: "nl",
    label: "Nederlands",
    flag: "🇳🇱",
  },
  {
    language: "en-US",
    iso639_1: "en",
    label: "English",
    flag: "🇺🇸",
  },
  {
    language: "de-DE",
    iso639_1: "de",
    label: "Deutsch",
    flag: "🇩🇪",
  },
  {
    language: "fr-FR",
    iso639_1: "fr",
    label: "Français",
    flag: "🇫🇷",
  },
  {
    language: "es-ES",
    iso639_1: "es",
    label: "Español",
    flag: "🇪🇸",
  },
];

export const languageOptions = data.map((d) => ({
  value: d.language,
  label: `${d.label} ${d.flag}`,
}));

export const languageOptionsByIso639_1 = data.map((d) => ({
  value: d.iso639_1,
  label: `${d.label} ${d.flag}`,
}));

export const LanguagePicker = () => {
  const { language: currentLanguage } = useLanguage();
  const { pathname } = useLocation();

  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const selectedLanguage = e.target.value;

    // If the selected language is the same as the current language, do nothing
    if (selectedLanguage === currentLanguage) return;

    // Check if we're in a chat context
    const isInChat = pathname.includes("/chats/");
    if (isInChat) {
      const confirmed = window.confirm(
        t`Changing language during an active chat may lead to unexpected results. It's recommended to start a new chat after changing the language. Are you sure you want to continue?`,
      );
      if (!confirmed) {
        return;
      }
    }

    let newPathname = pathname;

    // Remove existing language from the pathname
    SUPPORTED_LANGUAGES.forEach((lang) => {
      if (newPathname.startsWith(`/${lang}/`)) {
        newPathname = newPathname.replace(`/${lang}`, "");
      } else if (newPathname === `/${lang}`) {
        newPathname = "/";
      }
    });

    // use browser history to navigate to the new language path
    // otherwise the language change found to be inconsistent!
    window.location.href = `/${selectedLanguage}${newPathname}`;
  };

  return (
    <NativeSelect
      data={languageOptions}
      value={currentLanguage}
      onChange={handleChange}
    />
  );
};
