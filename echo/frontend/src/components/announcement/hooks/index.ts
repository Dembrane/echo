import { aggregate, createItems, type Query, readItems } from "@directus/sdk";
import { t } from "@lingui/core/macro";
import * as Sentry from "@sentry/react";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import useSessionStorageState from "use-session-storage-state";
import { useCurrentUser } from "@/components/auth/hooks";
import { toast } from "@/components/common/Toaster";
import { directus } from "@/lib/directus";

export const useLatestAnnouncement = () => {
	const { data: currentUser } = useCurrentUser();

	return useQuery({
		queryFn: async () => {
			try {
				const response = await directus.request(
					readItems("announcement", {
						deep: {
							// @ts-expect-error
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
						filter: {
							_or: [
								{
									expires_at: {
										// @ts-expect-error
										_gte: new Date().toISOString(),
									},
								},
								{
									expires_at: {
										_null: true,
									},
								},
							],
						},
						limit: 1,
						sort: ["-created_at"],
					}),
				);

			return response.length > 0 ? response[0] : null;
		} catch (error) {
			Sentry.captureException(error);
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
		enabled,
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
							// @ts-expect-error
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
						filter: {
							_or: [
								{
									expires_at: {
										// @ts-expect-error
										_gte: new Date().toISOString(),
									},
								},
								{
									expires_at: {
										_null: true,
									},
								},
							],
						},
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
			Sentry.captureException(error);
			console.error("Error fetching announcements:", error);
			throw error;
		}
		},
		queryKey: ["announcements", "infinite", query],
	});
};

export const useMarkAsReadMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({
			announcementId,
			userId,
		}: {
			announcementId: string;
			userId?: string;
		}) => {
			try {
				return await directus.request(
					createItems("announcement_activity", {
						announcement_activity: announcementId,
						read: true,
						...(userId ? { user_id: userId } : {}),
					} as any),
				);
			} catch (error) {
				Sentry.captureException(error);
				toast.error(t`Failed to mark announcement as read`);
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

			// // Optimistically update unread count
			queryClient.setQueriesData(
				{ queryKey: ["announcements", "unread"] },
				(old: number) => {
					if (typeof old !== "number") return old;
					return Math.max(0, old - 1);
				},
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

export const useMarkAllAsReadMutation = () => {
	const queryClient = useQueryClient();
	const { data: currentUser } = useCurrentUser();

	return useMutation({
		mutationFn: async () => {
			try {
				// Step 1: Find all announcement IDs that don't have activity for this user
				const unreadAnnouncements = await directus.request(
					readItems("announcement", {
						fields: ["id"],
						filter: {
							_and: [
								{
									// Only get announcements that don't have activity records for this user
									activity: {
										_none: {
											user_id: {
												_eq: currentUser?.id,
											},
										},
									},
								},
								{
									_or: [
										{
											expires_at: {
												// @ts-expect-error
												_gte: new Date().toISOString(),
											},
										},
										{
											expires_at: {
												_null: true,
											},
										},
									],
								},
							],
						},
					}),
				);

				// Step 2: Create activity records for all unread announcements
				if (unreadAnnouncements.length > 0) {
					return await directus.request(
						createItems(
							"announcement_activity",
							unreadAnnouncements.map((announcement) => ({
								announcement_activity: announcement.id,
								read: true,
								...(currentUser?.id ? { user_id: currentUser.id } : {}),
							})) as any,
						),
					);
				}

				return [];
			} catch (error) {
				Sentry.captureException(error);
				toast.error(t`Failed to mark all announcements as read`);
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

			// Optimistically update unread count to 0
			queryClient.setQueriesData({ queryKey: ["announcements", "unread"] }, 0);

			// Return a context object with the snapshotted value
			return { previousAnnouncements };
		},
		onSettled: () => {
			// refetch after error or success to ensure cache consistency
			queryClient.invalidateQueries({ queryKey: ["announcements"] });
		},
	});
};

export const useUnreadAnnouncements = () => {
	const { data: currentUser } = useCurrentUser();

	return useQuery({
		enabled: !!currentUser?.id, // Only run query if user is logged in
		queryFn: async () => {
			try {
				// If no user is logged in, return 0
				if (!currentUser?.id) {
					return 0;
				}

				const unreadAnnouncements = await directus.request(
					aggregate("announcement", {
						aggregate: { count: "*" },
						query: {
							filter: {
								_or: [
									{
										expires_at: {
											_gte: new Date().toISOString(),
										},
									},
									{
										expires_at: {
											_null: true,
										},
									},
								],
							},
						},
					}),
				);

				const activities = await directus.request(
					aggregate("announcement_activity", {
						aggregate: { count: "*" },
						query: {
							filter: {
								_and: [
									{
										user_id: { _eq: currentUser.id },
									},
								],
							},
						},
					}),
				);

			const count =
				Number.parseInt(unreadAnnouncements?.[0]?.count?.toString() ?? "0") -
				Number.parseInt(activities?.[0]?.count?.toString() ?? "0");
			return Math.max(0, count);
		} catch (error) {
			Sentry.captureException(error);
			console.error("Error fetching unread announcements count:", error);
			throw error;
		}
		},
		queryKey: ["announcements", "unread", currentUser?.id],
		retry: 2,
		staleTime: 1000 * 60 * 5, // 5 minutes
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
