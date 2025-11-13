import { useMemo } from "react";

export const getTranslatedContent = (
	announcement: Announcement,
	language: string,
) => {
	const translation =
		announcement.translations?.find(
			(t) =>
				(t as AnnouncementTranslation).languages_code === language &&
				(t as AnnouncementTranslation).title,
		) ||
		announcement.translations?.find(
			(t) => (t as AnnouncementTranslation).languages_code === "en-US",
		);

	return {
		message: (translation as AnnouncementTranslation)?.message || "",
		title: (translation as AnnouncementTranslation)?.title || "",
	};
};

// @FIXME: this doesn't need to be a hook, it can be a simple function, memo for a .find is overkill
export function useProcessedAnnouncements(
	announcements: Announcement[],
	language: string,
) {
	return useMemo(() => {
		return announcements.map((announcement) => {
			const { title, message } = getTranslatedContent(announcement, language);

			return {
				created_at: announcement.created_at,
				expires_at: announcement.expires_at,
				id: announcement.id,
				level: announcement.level as "info" | "urgent",
				message,
				read:
					(announcement.activity?.[0] as AnnouncementActivity)?.read || false,
				title,
			};
		});
	}, [announcements, language]);
}
