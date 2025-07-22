import {
  deleteResourceById,
  getResourceById,
  updateResourceById,
} from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";

export const useUpdateResourceByIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateResourceById,
    onSuccess: (_values, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["resources", variables.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      toast.success("Resource updated successfully");
    },
  });
};

export const useDeleteResourceByIdMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteResourceById,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      queryClient.invalidateQueries({
        queryKey: ["resources"],
      });
      toast.success("Resource deleted successfully");
    },
  });
};

export const useResourceById = (resourceId: string) => {
  return useQuery({
    queryKey: ["resources", resourceId],
    queryFn: () => getResourceById(resourceId),
  });
};
