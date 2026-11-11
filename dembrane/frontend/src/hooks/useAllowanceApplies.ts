import { useProjectById } from "@/components/project/hooks";

// Sample projects are exempt; until is_sample loads the allowance does not apply and the server's 402 decides.
export function useAllowanceApplies(projectId: string | null | undefined): {
	applies: boolean;
	isSample: boolean;
} {
	const query = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "is_sample"] },
	});
	const isSample = query.data?.is_sample === true;
	return { applies: query.isSuccess && !isSample, isSample };
}
