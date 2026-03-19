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

export const isWhatsNew = (announcement: Announcement): boolean => {
	const enTranslation = announcement.translations?.find(
		(t) => (t as AnnouncementTranslation).languages_code === "en-US",
	);
	const title =
		(enTranslation as AnnouncementTranslation)?.title?.toLowerCase() || "";
	return title.includes("new features") || title.startsWith("new:");
};

export interface ProcessedAnnouncement {
	id: string;
	created_at: string | Date | null | undefined;
	expires_at?: string | Date | null | undefined;
	level: "info" | "urgent";
	title: string;
	message: string;
	read: boolean;
}

function processAnnouncement(
	announcement: Announcement,
	language: string,
): ProcessedAnnouncement {
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
}

function sortByDateDesc(a: ProcessedAnnouncement, b: ProcessedAnnouncement) {
	const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
	const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
	return dateB - dateA;
}

export function useProcessedAnnouncements(
	announcements: Announcement[],
	language: string,
) {
	return useMemo(() => {
		const processed = announcements
			.filter((a) => !isWhatsNew(a))
			.map((a) => processAnnouncement(a, language));

		// Sort: unread first, then by date descending
		return processed.sort((a, b) => {
			if (a.read !== b.read) return a.read ? 1 : -1;
			return sortByDateDesc(a, b);
		});
	}, [announcements, language]);
}

export function useWhatsNewProcessed(
	announcements: Announcement[],
	language: string,
) {
	return useMemo(() => {
		return announcements
			.filter((a) => isWhatsNew(a))
			.map((a) => processAnnouncement(a, language))
			.sort(sortByDateDesc);
	}, [announcements, language]);
}
