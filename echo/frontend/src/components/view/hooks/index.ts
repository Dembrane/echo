import { generateProjectView } from "@/lib/api";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";

export const useGenerateProjectViewMutation = () => {
  return useMutation({
    mutationFn: generateProjectView,
    onSuccess: () => {
      toast.success("Analysis requested successfully");
    },
  });
};
