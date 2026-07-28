import type { MethodologyListItem } from "./hooks";

export const createFixtureMethodologies = (
	workspaceId: string,
): MethodologyListItem[] => [
	{
		description: "The default dembrane setup methodology.",
		framing:
			"Help the host decide what this project is for, who should help define it, and whether the project should collect that input before reports or canvases are shaped.",
		id: `${workspaceId}-dembrane`,
		is_seeded: true,
		latest_version: {
			created_at: new Date().toISOString(),
			id: `${workspaceId}-dembrane-v2`,
			note: "Official dembrane methodology v2",
		},
		name: "dembrane",
		versions_count: 1,
	},
	{
		description: "A reusable setup for day-long panel sessions",
		framing:
			"Keep tables aligned around neighbourhood concerns and suggestions.",
		id: `${workspaceId}-panel-day`,
		is_seeded: false,
		latest_version: {
			created_at: new Date().toISOString(),
			id: `${workspaceId}-panel-day-v2`,
			note: "Tightened framing",
		},
		name: "Panel day",
		versions_count: 2,
	},
];
