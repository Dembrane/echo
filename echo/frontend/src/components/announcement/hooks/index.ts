import {
	createItems,
	type Query,
	readItems,
	updateItem,
	updateItems,
} from "@directus/sdk";
import { t } from "@lingui/core/macro";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import posthog from "posthog-js";
import { useEffect } from "react";
import useSessionStorageState from "use-session-storage-state";
import { useCurrentUser } from "@/components/auth/hooks";
import { toast } from "@/components/common/Toaster";
import { directus } from "@/lib/directus";
import { isUnreadByMe, notExpiredFilter } from "../announcementFilters";

export const useLatestAnnouncement = () => {
	const { data: currentUser } = useCurrentUser();

	return useQuery({
		// Without a user this 403s on every cold load.
		enabled: !!currentUser?.id,
		queryFn: async () => {
			try {
				const response = await directus.request(
					readItems("announcement", {
						deep: {
							activity: {
								_filter: {
									user_id: {
										_eq: currentUser?.id,
									},
								},
							},
						},
						fields: [
							"id",
							"created_at",
							"expires_at",
							"level",
							{
								translations: ["id", "languages_code", "title", "message"],
							},
							{
								activity: ["id", "user_id", "announcement_activity", "read"],
							},
						],
						filter: notExpiredFilter(),
						limit: 1,
						sort: ["-created_at"],
					}),
				);

				return response.length > 0 ? response[0] : null;
			} catch (error) {
				posthog.captureException(error);
				console.error("Error fetching latest announcement:", error);
				throw error;
			}
		},
		queryKey: ["announcements", "latest"],
		retry: 2,
		staleTime: 1000 * 60 * 5, // 5 minutes
	});
};

export const useInfiniteAnnouncements = ({
	query,
	options = {
		initialLimit: 10,
	},
	enabled = true,
}: {
	query?: Partial<Query<CustomDirectusTypes, Announcement>>;
	options?: {
		initialLimit?: number;
	};
	enabled?: boolean;
}) => {
	const { data: currentUser } = useCurrentUser();
	const { initialLimit = 10 } = options;

	return useInfiniteQuery({
		// Firing before auth resolves caches a wrong result under a stale key.
		enabled: enabled && !!currentUser?.id,
		getNextPageParam: (lastPage: {
			announcements: Announcement[];
			nextOffset?: number;
		}) => lastPage.nextOffset,
		initialPageParam: 0,
		queryFn: async ({ pageParam = 0 }) => {
			try {
				const response: Announcement[] = await directus.request<Announcement[]>(
					readItems("announcement", {
						deep: {
							activity: {
								_filter: {
									user_id: {
										_eq: currentUser?.id,
									},
								},
							},
						},
						fields: [
							"id",
							"created_at",
							"expires_at",
							"level",
							{
								translations: ["id", "languages_code", "title", "message"],
							},
							{
								activity: ["id", "user_id", "announcement_activity", "read"],
							},
						],
						filter: notExpiredFilter(),
						limit: initialLimit,
						offset: pageParam * initialLimit,
						sort: ["-created_at"],
						...query,
					}),
				);

				return {
					announcements: response,
					nextOffset:
						response.length === initialLimit ? pageParam + 1 : undefined,
				};
			} catch (error) {
				posthog.captureException(error);
				console.error("Error fetching announcements:", error);
				throw error;
			}
		},
		queryKey: ["announcements", "infinite", currentUser?.id, query],
	});
};

export const useMarkAsReadMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			announcementId,
			activityIds,
			userId,
		}: {
			announcementId: string;
			/** Existing rows for this user, if any. Passing them avoids duplicates. */
			activityIds?: string[];
			userId?: string;
		}) => {
			try {
				// Update in place; a second row would pile up on every toggle.
				if (activityIds && activityIds.length > 0) {
					return await directus.request(
						updateItems("announcement_activity", activityIds, {
							read: true,
						} as any),
					);
				}

				return await directus.request(
					createItems("announcement_activity", {
						announcement_activity: announcementId,
						read: true,
						...(userId ? { user_id: userId } : {}),
					} as any),
				);
			} catch (error) {
				toast.error(t`Failed to mark announcement as read`);
				posthog.captureException(error);
				console.error("Error in mutationFn:", error);
				throw error;
			}
		},
		onError: (
			err,
			_newAnnouncementId,
			context: { previousAnnouncements?: [any, any][] } = {},
		) => {
			// If the mutation fails, use the context returned from onMutate to roll back
			if (context?.previousAnnouncements) {
				context.previousAnnouncements.forEach(
					([queryKey, data]: [any, any]) => {
						queryClient.setQueriesData({ queryKey }, data);
					},
				);
			}
			console.error("Error marking announcement as read:", err);
			toast.error(t`Failed to mark announcement as read`);
		},
		onMutate: async ({ announcementId }) => {
			// Cancel any outgoing refetches
			await queryClient.cancelQueries({ queryKey: ["announcements"] });

			// Snapshot the previous value
			const previousAnnouncements = queryClient.getQueriesData({
				queryKey: ["announcements"],
			});

			// Optimistically update infinite announcements
			queryClient.setQueriesData(
				{ queryKey: ["announcements", "infinite"] },
				(old: any) => {
					if (!old) return old;
					return {
						...old,
						pages: old.pages.map((page: any) => ({
							...page,
							announcements: page.announcements.map((announcement: any) => {
								if (announcement.id === announcementId) {
									return {
										...announcement,
										activity: [
											{
												announcement_activity: announcement.id,
												id: `temp-${announcement.id}`,
												read: true,
												user_id: null,
											},
										],
									};
								}
								return announcement;
							}),
						})),
					};
				},
			);

			// // Optimistically update latest announcement
			queryClient.setQueriesData(
				{ queryKey: ["announcements", "latest"] },
				(old: any) => {
					if (!old || old.id !== announcementId) return old;
					return {
						...old,
						activity: [
							{
								announcement_activity: old.id,
								id: `temp-${old.id}`,
								read: true,
								user_id: null,
							},
						],
					};
				},
			);

			// Count and urgent title are `select`s over these rows, so both follow.
			queryClient.setQueriesData(
				{ queryKey: ["announcements", "summary"] },
				(old: { id: string }[]) =>
					Array.isArray(old)
						? old.map((row) =>
								row.id === announcementId
									? { ...row, activity: [{ read: true }] }
									: row,
							)
						: old,
			);

			// Return a context object with the snapshotted value
			return { previousAnnouncements };
		},
		onSettled: () => {
			// refetch after error or success to ensure cache consistency
			queryClient.invalidateQueries({ queryKey: ["announcements"] });
		},
	});
};

export const useMarkAsUnreadMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({
			activityIds,
		}: {
			announcementId: string;
			activityIds: string[];
		}) => {
			try {
				const updates = activityIds.map((id) =>
					directus.request(
						updateItem("announcement_activity", id, { read: false } as any),
					),
				);
				return await Promise.all(updates);
			} catch (error) {
				toast.error(t`Failed to mark announcement as unread`);
				posthog.captureException(error);
				console.error("Error in markAsUnread mutationFn:", error);
				throw error;
			}
		},
		onError: (
			err,
			_variables,
			context: { previousAnnouncements?: [any, any][] } = {},
		) => {
			if (context?.previousAnnouncements) {
				context.previousAnnouncements.forEach(
					([queryKey, data]: [any, any]) => {
						queryClient.setQueriesData({ queryKey }, data);
					},
				);
			}
			console.error("Error marking announcement as unread:", err);
			toast.error(t`Failed to mark announcement as unread`);
		},
		onMutate: async ({ announcementId }) => {
			await queryClient.cancelQueries({ queryKey: ["announcements"] });

			const previousAnnouncements = queryClient.getQueriesData({
				queryKey: ["announcements"],
			});

			// Optimistically update infinite announcements - set read to false
			queryClient.setQueriesData(
				{ queryKey: ["announcements", "infinite"] },
				(old: any) => {
					if (!old) return old;
					return {
						...old,
						pages: old.pages.map((page: any) => ({
							...page,
							announcements: page.announcements.map((announcement: any) => {
								if (announcement.id === announcementId) {
									return {
										...announcement,
										activity:
											announcement.activity?.map((a: any) => ({
												...a,
												read: false,
											})) ?? [],
									};
								}
								return announcement;
							}),
						})),
					};
				},
			);

			// Optimistically update latest announcement
			queryClient.setQueriesData(
				{ queryKey: ["announcements", "latest"] },
				(old: any) => {
					if (!old || old.id !== announcementId) return old;
					return {
						...old,
						activity:
							old.activity?.map((a: any) => ({ ...a, read: false })) ?? [],
					};
				},
			);

			queryClient.setQueriesData(
				{ queryKey: ["announcements", "summary"] },
				(old: { id: string }[]) =>
					Array.isArray(old)
						? old.map((row) =>
								row.id === announcementId
									? { ...row, activity: [{ read: false }] }
									: row,
							)
						: old,
			);

			return { previousAnnouncements };
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["announcements"] });
		},
	});
};

export const useMarkAllAsReadMutation = () => {
	const queryClient = useQueryClient();
	const { data: currentUser } = useCurrentUser();

	return useMutation({
		mutationFn: async () => {
			try {
				// `deep._filter` scopes the rows to me and, unlike a permission, holds
				// for admins too, who would otherwise overwrite other people's rows.
				const liveAnnouncements = (await directus.request(
					readItems("announcement", {
						deep: {
							activity: { _filter: { user_id: { _eq: currentUser?.id } } },
						},
						fields: ["id", { activity: ["id", "read"] }],
						filter: notExpiredFilter(),
						limit: -1,
					}),
				)) as {
					id: string;
					activity?: { id: string; read?: boolean | null }[];
				}[];

				const unreadAnnouncements = liveAnnouncements.filter((announcement) =>
					isUnreadByMe(announcement.activity),
				);

				const activityIdsToUpdate = unreadAnnouncements.flatMap(
					(announcement) =>
						(announcement.activity ?? []).map((activity) => activity.id),
				);
				const announcementsToCreate = unreadAnnouncements.filter(
					(announcement) => (announcement.activity ?? []).length === 0,
				);

				const results = [];

				if (activityIdsToUpdate.length > 0) {
					results.push(
						await directus.request(
							updateItems("announcement_activity", activityIdsToUpdate, {
								read: true,
							} as any),
						),
					);
				}

				if (announcementsToCreate.length > 0) {
					results.push(
						await directus.request(
							createItems(
								"announcement_activity",
								announcementsToCreate.map((announcement) => ({
									announcement_activity: announcement.id,
									read: true,
									...(currentUser?.id ? { user_id: currentUser.id } : {}),
								})) as any,
							),
						),
					);
				}

				return results;
			} catch (error) {
				toast.error(t`Failed to mark all announcements as read`);
				posthog.captureException(error);
				console.error("Error in markAllAsRead mutationFn:", error);
				throw error;
			}
		},
		onError: (err, _variables, context) => {
			// If the mutation fails, use the context returned from onMutate to roll back
			if (context?.previousAnnouncements) {
				context.previousAnnouncements.forEach(([queryKey, data]) => {
					queryClient.setQueriesData({ queryKey }, data);
				});
			}
			console.error("Error marking all announcements as read:", err);
			toast.error(t`Failed to mark all announcements as read`);
		},
		onMutate: async () => {
			// Cancel any outgoing refetches
			await queryClient.cancelQueries({ queryKey: ["announcements"] });

			// Snapshot the previous value
			const previousAnnouncements = queryClient.getQueriesData({
				queryKey: ["announcements"],
			});

			// Optimistically update infinite announcements - mark all as read
			queryClient.setQueriesData(
				{ queryKey: ["announcements", "infinite"] },
				(old: any) => {
					if (!old) return old;
					return {
						...old,
						pages: old.pages.map((page: any) => ({
							...page,
							announcements: page.announcements.map((announcement: any) => ({
								...announcement,
								activity: [
									{
										announcement_activity: announcement.id,
										id: `temp-all-${announcement.id}`,
										read: true,
										user_id: currentUser?.id || null,
									},
								],
							})),
						})),
					};
				},
			);

			// Optimistically update latest announcement
			queryClient.setQueriesData(
				{ queryKey: ["announcements", "latest"] },
				(old: any) => {
					if (!old) return old;
					return {
						...old,
						activity: [
							{
								announcement_activity: old.id,
								id: `temp-all-${old.id}`,
								read: true,
								user_id: currentUser?.id || null,
							},
						],
					};
				},
			);

			queryClient.setQueriesData(
				{ queryKey: ["announcements", "summary"] },
				(old: unknown[]) =>
					Array.isArray(old)
						? old.map((row) => ({
								...(row as object),
								activity: [{ read: true }],
							}))
						: old,
			);

			// Return a context object with the snapshotted value
			return { previousAnnouncements };
		},
		onSettled: () => {
			// refetch after error or success to ensure cache consistency
			queryClient.invalidateQueries({ queryKey: ["announcements"] });
		},
	});
};

type SummaryRow = Announcement & { activity?: { read?: boolean | null }[] };

/**
 * Backs both the unread count and the urgent title as two `select`s over one
 * cache entry: a single poll, and the two can never disagree.
 */
const useAnnouncementSummary = <T>(select: (rows: SummaryRow[]) => T) => {
	const { data: currentUser } = useCurrentUser();

	return useQuery({
		enabled: !!currentUser?.id,
		queryFn: async () => {
			try {
				if (!currentUser?.id) {
					return [] as SummaryRow[];
				}

				return (await directus.request(
					readItems("announcement", {
						deep: {
							activity: { _filter: { user_id: { _eq: currentUser.id } } },
						},
						fields: [
							"id",
							"created_at",
							"level",
							{ translations: ["id", "languages_code", "title"] },
							{ activity: ["read"] },
						],
						filter: notExpiredFilter(),
						limit: -1,
						sort: ["-created_at"],
					}),
				)) as SummaryRow[];
			} catch (error) {
				posthog.captureException(error);
				console.error("Error fetching announcement summary:", error);
				throw error;
			}
		},
		queryKey: ["announcements", "summary", currentUser?.id],
		refetchInterval: 60_000,
		retry: 2,
		select,
		staleTime: 1000 * 60 * 5, // 5 minutes
	});
};

// Module scope keeps these referentially stable across renders.
const selectUnreadCount = (rows: SummaryRow[]) =>
	rows.filter((row) => isUnreadByMe(row.activity)).length;

const selectTopUrgentUnread = (rows: SummaryRow[]) =>
	rows.find((row) => row.level === "urgent" && isUnreadByMe(row.activity)) ??
	null;

export const useUnreadAnnouncements = () =>
	useAnnouncementSummary(selectUnreadCount);

export const useTopUrgentUnreadAnnouncement = () =>
	useAnnouncementSummary(selectTopUrgentUnread);

export const useWhatsNewAnnouncements = ({
	enabled = true,
}: {
	enabled?: boolean;
} = {}) => {
	const { data: currentUser } = useCurrentUser();

	return useQuery({
		enabled,
		queryFn: async () => {
			try {
				const response: Announcement[] = await directus.request<Announcement[]>(
					readItems("announcement", {
						deep: {
							activity: {
								_filter: {
									user_id: {
										_eq: currentUser?.id,
									},
								},
							},
						},
						fields: [
							"id",
							"created_at",
							"expires_at",
							"level",
							{
								translations: ["id", "languages_code", "title", "message"],
							},
							{
								activity: ["id", "user_id", "announcement_activity", "read"],
							},
						],
						limit: 50,
						sort: ["-created_at"],
					}),
				);

				return response;
			} catch (error) {
				posthog.captureException(error);
				console.error("Error fetching what's new announcements:", error);
				throw error;
			}
		},
		queryKey: ["announcements", "whats-new"],
		retry: 2,
		staleTime: 1000 * 60 * 5,
	});
};

export const useAnnouncementDrawer = () => {
	const [isOpen, setIsOpen] = useSessionStorageState(
		"announcement-drawer-open",
		{
			defaultValue: false,
		},
	);

	// Reset drawer state on page reload

	// biome-ignore lint/correctness/useExhaustiveDependencies: false positive
	useEffect(() => {
		setIsOpen(false);
	}, []);

	const open = () => setIsOpen(true);
	const close = () => setIsOpen(false);
	const toggle = () => setIsOpen(!isOpen);

	return {
		close,
		isOpen,
		open,
		setIsOpen,
		toggle,
	};
};
