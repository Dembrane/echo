import { useMemo } from "react";

export function useProcessedAnnouncements(
  announcements: Announcement[],
  language: string,
) {
  return useMemo(() => {
    return announcements.map((announcement) => {
      const translation =
        announcement.translations?.find((t) => t.languages_code === language) ||
        announcement.translations?.[0];

      return {
        id: announcement.id,
        title: translation?.title || "",
        message: translation?.message || "",
        created_at: announcement.created_at,
        expires_at: announcement.expires_at,
        level: announcement.level as "info" | "urgent",
        read: announcement.activity?.[0]?.read || false,
      };
    });
  }, [announcements, language]);
}
