import type { ProjectGoalResponse } from "./hooks";

export const createFixtureProjectGoal = (
	projectId: string,
): ProjectGoalResponse => {
	const now = new Date();
	const earlier = new Date(now.getTime() - 1000 * 60 * 60 * 24);
	const oldest = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 3);

	return {
		current: {
			content:
				"Understand what participants need from this project, surface the strongest themes, and turn them into a clear next step for the host.",
			created_at: now.toISOString(),
			id: `${projectId}-goal-current`,
			set_by: "interview",
		},
		revisions: [
			{
				content:
					"Understand what participants need from this project, surface the strongest themes, and turn them into a clear next step for the host.",
				created_at: now.toISOString(),
				id: `${projectId}-goal-current`,
				set_by: "interview",
			},
			{
				content:
					"Collect useful participant feedback and summarize the main tensions for the project team.",
				created_at: earlier.toISOString(),
				id: `${projectId}-goal-previous`,
				set_by: "you",
			},
			{
				content:
					"Make it easier to decide what this project should focus on before inviting participants.",
				created_at: oldest.toISOString(),
				id: `${projectId}-goal-oldest`,
				set_by: "loop",
			},
		],
	};
};
