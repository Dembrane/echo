import { useQuery } from "@tanstack/react-query";
import { checkUnsubscribeStatus } from "@/lib/api";

export const useCheckUnsubscribeStatus = (token: string, projectId: string) => {
  return useQuery<{ eligible: boolean }>({
    queryKey: ["checkUnsubscribe", token, projectId],
    queryFn: async () => {
      if (!token || !projectId) {
        throw new Error("Invalid or missing unsubscribe link.");
      }
      const response = await checkUnsubscribeStatus(token, projectId);
      return response.data;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
};
