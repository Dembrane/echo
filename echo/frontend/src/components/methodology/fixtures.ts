import type { MethodologyListItem } from "./hooks";

export const createFixtureMethodologies = (
	workspaceId: string,
): MethodologyListItem[] => [
	{
		id: `${workspaceId}-dembrane`,
		name: "dembrane",
		description: "Default setup conversation",
		framing: "Figure out what this project is for, then shape the work around it.",
		is_seeded: true,
		latest_version: {
			id: `${workspaceId}-dembrane-v1`,
			note: "Initial history",
			created_at: new Date().toISOString(),
		},
		versions_count: 1,
	},
	{
		id: `${workspaceId}-panel-day`,
		name: "Panel day",
		description: "A reusable setup for day-long panel sessions",
		framing: "Keep tables aligned around neighbourhood concerns and suggestions.",
		is_seeded: false,
		latest_version: {
			id: `${workspaceId}-panel-day-v2`,
			note: "Tightened framing",
			created_at: new Date().toISOString(),
		},
		versions_count: 2,
	},
];
