import { useQuery } from "@tanstack/react-query";
import { getParticipantProjectById } from "@/lib/api";

export const useParticipantProjectById = (projectId: string) => {
	return useQuery({
		queryFn: () => getParticipantProjectById(projectId),
		queryKey: ["participantProject", projectId],
	});
};
