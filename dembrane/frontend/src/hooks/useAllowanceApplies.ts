import { useProjectById } from "@/components/project/hooks";

// The AI budget applies to samples too; until the project loads it does not apply and the server's 402 decides.
export function useAllowanceApplies(projectId: string | null | undefined): {
	applies: boolean;
	isSample: boolean;
} {
	const query = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "is_sample"] },
	});
	const isSample = query.data?.is_sample === true;
	return { applies: query.isSuccess, isSample };
}
