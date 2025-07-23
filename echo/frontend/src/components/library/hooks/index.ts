import {
  generateProjectLibrary,
  getProjectViews,
} from "@/lib/api";
import { directus } from "@/lib/directus";
import { readItem } from "@directus/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";

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
          fields: [
            "*",
            {
              aspects: ["*", "count(aspect_segment)"],
            },
          ],
          deep: {
            // get the aspects that have at least one aspect segment
            aspects: {
              _sort: "-count(aspect_segment)",
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
              "aspect_segment": [
                "*",
                { 
                  "segment": [
                    "*",
                  ]
                }
              ]
            }
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
