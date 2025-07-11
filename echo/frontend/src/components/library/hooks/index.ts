import {
  generateProjectLibrary,
  getProjectInsights,
  getProjectViews,
} from "@/lib/api";
import { directus } from "@/lib/directus";
import { readItem } from "@directus/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";

export const useProjectInsights = (projectId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "insights"],
    queryFn: () => getProjectInsights(projectId),
  });
};

export const useInsight = (insightId: string) => {
  return useQuery({
    queryKey: ["insights", insightId],
    queryFn: () =>
      directus.request<Insight>(
        readItem("insight", insightId, {
          fields: [
            "*",
            {
              quotes: [
                "*",
                {
                  conversation_id: ["id", "participant_name", "created_at"],
                },
              ],
            },
          ],
        }),
      ),
  });
};

export const useProjectViews = (projectId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "views"],
    queryFn: () => getProjectViews(projectId),
    refetchInterval: 20000,
  });
};

export const useViewById = (projectId: string, viewId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "views", viewId],
    queryFn: () =>
      directus.request<View>(
        readItem("view", viewId, {
          fields: ["*", { aspects: ["*", "count(quotes)"] }],
          deep: {
            // get the aspects that have at least one representative quote
            aspects: {
              _sort: "-count(representative_quotes)",
            } as any,
          },
        }),
      ),
  });
};

export const useAspectById = (projectId: string, aspectId: string) => {
  return useQuery({
    queryKey: ["projects", projectId, "aspects", aspectId],
    queryFn: () =>
      directus.request<Aspect>(
        readItem("aspect", aspectId, {
          fields: [
            "*",
            {
              quotes: [
                "*",
                {
                  quote_id: [
                    "id",
                    "text",
                    "created_at",
                    {
                      conversation_id: ["id", "participant_name", "created_at"],
                    },
                  ],
                },
              ],
            },
            {
              representative_quotes: [
                "*",
                {
                  quote_id: [
                    "id",
                    "text",
                    "created_at",
                    {
                      conversation_id: ["id", "participant_name", "created_at"],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
  });
};

export const useGenerateProjectLibraryMutation = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: generateProjectLibrary,
    onSuccess: (_, variables) => {
      toast.success("Analysis requested successfully");
      client.invalidateQueries({ queryKey: ["projects", variables.projectId] });
    },
  });
};
