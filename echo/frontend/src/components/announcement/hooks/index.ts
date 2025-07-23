import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import * as Sentry from "@sentry/react";
import { Query, readItems, createItems, aggregate } from "@directus/sdk";
import { directus } from "@/lib/directus";
import { toast } from "@/components/common/Toaster";
import { t } from "@lingui/core/macro";
import { useCurrentUser } from "@/components/auth/hooks";
import { useEffect } from "react";
import useSessionStorageState from "use-session-storage-state";

export const useLatestAnnouncement = () => {
  const { data: currentUser } = useCurrentUser();

  return useQuery({
    queryKey: ["announcements", "latest"],
    queryFn: async () => {
      try {
        const response = await directus.request(
          readItems("announcement", {
            filter: {
              _or: [
                {
                  expires_at: {
                    // @ts-ignore
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
            deep: {
              // @ts-ignore
              activity: {
                _filter: {
                  user_id: {
                    _eq: currentUser?.id,
                  },
                },
              },
            },
            sort: ["-created_at"],
            limit: 1,
          }),
        );

        return response.length > 0 ? response[0] : null;
      } catch (error) {
        Sentry.captureException(error);
        toast.error(t`Failed to get the latest announcement`);
        console.error("Error fetching latest announcement:", error);
        throw error;
      }
    },
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
    queryKey: ["announcements", "infinite", query],
    enabled,
    queryFn: async ({ pageParam = 0 }) => {
      try {
        const response = await directus.request(
          readItems("announcement", {
            filter: {
              _or: [
                {
                  expires_at: {
                    // @ts-ignore
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
            deep: {
              // @ts-ignore
              activity: {
                _filter: {
                  user_id: {
                    _eq: currentUser?.id,
                  },
                },
              },
            },
            sort: ["-created_at"],
            limit: initialLimit,
            offset: pageParam * initialLimit,
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
        toast.error(t`Failed to get announcements`);
        console.error("Error fetching announcements:", error);
        throw error;
      }
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset,
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
                        id: `temp-${announcement.id}`,
                        read: true,
                        user_id: null,
                        announcement_activity: announcement.id,
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
                id: `temp-${old.id}`,
                read: true,
                user_id: null,
                announcement_activity: old.id,
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
    onError: (err, _newAnnouncementId, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousAnnouncements) {
        context.previousAnnouncements.forEach(([queryKey, data]) => {
          queryClient.setQueriesData({ queryKey }, data);
        });
      }
      console.error("Error marking announcement as read:", err);
      toast.error(t`Failed to mark announcement as read`);
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
                        // @ts-ignore
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
            fields: ["id"],
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
                    id: `temp-all-${announcement.id}`,
                    read: true,
                    user_id: currentUser?.id || null,
                    announcement_activity: announcement.id,
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
                id: `temp-all-${old.id}`,
                read: true,
                user_id: currentUser?.id || null,
                announcement_activity: old.id,
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
    onSettled: () => {
      // refetch after error or success to ensure cache consistency
      queryClient.invalidateQueries({ queryKey: ["announcements"] });
    },
  });
};

export const useUnreadAnnouncements = () => {
  const { data: currentUser } = useCurrentUser();

  return useQuery({
    queryKey: ["announcements", "unread", currentUser?.id],
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
          parseInt(unreadAnnouncements?.[0]?.count?.toString() ?? "0") -
          parseInt(activities?.[0]?.count?.toString() ?? "0");
        return Math.max(0, count);
      } catch (error) {
        Sentry.captureException(error);
        toast.error(t`Failed to get unread announcements count`);
        console.error("Error fetching unread announcements count:", error);
        throw error;
      }
    },
    enabled: !!currentUser?.id, // Only run query if user is logged in
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
  useEffect(() => {
    setIsOpen(false);
  }, []);

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