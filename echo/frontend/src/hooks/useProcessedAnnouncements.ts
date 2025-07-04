import { useMemo } from "react";

export const getTranslatedContent = (announcement: Announcement, language: string) => {
  const translation =
    announcement.translations?.find(
      (t: AnnouncementTranslations) => t.languages_code === language && t.title,
    ) ||
    announcement.translations?.find((t: AnnouncementTranslations) => t.languages_code === "en-US");

  return {
    title: translation?.title || "",
    message: translation?.message || "",
  };
};

export function useProcessedAnnouncements(
  announcements: Announcement[],
  language: string,
) {
  return useMemo(() => {
    return announcements.map((announcement) => {
      const { title, message } = getTranslatedContent(announcement, language);

      return {
        id: announcement.id,
        title,
        message,
        created_at: announcement.created_at,
        expires_at: announcement.expires_at,
        level: announcement.level as "info" | "urgent",
        read: announcement.activity?.[0]?.read || false,
      };
    });
  }, [announcements, language]);
}
