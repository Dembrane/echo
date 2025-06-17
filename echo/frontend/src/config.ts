export const USE_PARTICIPANT_ROUTER =
  import.meta.env.VITE_USE_PARTICIPANT_ROUTER === "1";
export const ADMIN_BASE_URL =
  import.meta.env.VITE_ADMIN_BASE_URL ?? window.location.origin;
export const ADMIN_HOSTNAME =
  import.meta.env.VITE_ADMIN_HOSTNAME ?? window.location.hostname;
export const PARTICIPANT_BASE_URL =
  import.meta.env.VITE_PARTICIPANT_BASE_URL ?? window.location.origin;
export const PARTICIPANT_HOSTNAME =
  import.meta.env.VITE_PARTICIPANT_HOSTNAME ?? window.location.hostname;
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export const DIRECTUS_PUBLIC_URL =
  import.meta.env.VITE_DIRECTUS_PUBLIC_URL ?? "http://localhost:8055";

export const DIRECTUS_CONTENT_PUBLIC_URL =
  import.meta.env.VITE_DIRECTUS_CONTENT_PUBLIC_URL ??
  "https://dembrane.directus.app";

export const DISABLE_SENTRY = import.meta.env.VITE_DISABLE_SENTRY === "1";

export const BUILD_VERSION = import.meta.env.VITE_BUILD_VERSION ?? "dev";

export const SUPPORTED_LANGUAGES = [
  "en-US",
  "nl-NL",
  "de-DE",
  "fr-FR",
  "es-ES",
] as const;

export const PRIVACY_POLICY_URL =
  "https://dembrane.notion.site/Privacy-statements-all-languages-fa97a183f9d841f7a1089079e77ffb52" as const;

export const ENABLE_CHAT_AUTO_SELECT =
  import.meta.env.VITE_ENABLE_CHAT_AUTO_SELECT === "1";

export const PLAUSIBLE_API_HOST =
  import.meta.env.VITE_PLAUSIBLE_API_HOST ?? "https://plausible.io";

export const DEBUG_MODE = import.meta.env.VITE_DEBUG_MODE === "1";