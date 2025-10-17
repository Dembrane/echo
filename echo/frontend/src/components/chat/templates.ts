import { t } from "@lingui/core/macro";
import { IconBulb, IconCalculator, IconNotes } from "@tabler/icons-react";

export interface Template {
	id: string;
	title: string;
	icon?: typeof IconNotes;
	content: string;
}

export const Templates: Template[] = [
	{
		content: t`Transform this content into insights that actually matter. Please:

Extract core ideas that challenge standard thinking
Write like someone who understands nuance, not a textbook
Focus on the non-obvious implications
Keep it sharp and substantive
Only highlight truly meaningful patterns
Structure for clarity and impact
Balance depth with accessibility

Note: If the similarities/differences are too superficial, let me know we need more complex material to analyze.`,
		icon: IconNotes,
		id: "summarize",
		title: t`Summarize`,
	},
	{
		content: t`Analyze these elements with depth and nuance. Please:

Focus on unexpected connections and contrasts
Go beyond obvious surface-level comparisons
Identify hidden patterns that most analyses miss
Maintain analytical rigor while being engaging
Use examples that illuminate deeper principles
Structure the analysis to build understanding
Draw insights that challenge conventional wisdom

Note: If the similarities/differences are too superficial, let me know we need more complex material to analyze.`,
		icon: IconCalculator,
		id: "compare-contrast",
		title: t`Compare & Contrast`,
	},
	{
		content: t`Transform this discussion into actionable intelligence. Please:

Capture the strategic implications, not just talking points
Structure it like a thought leader's analysis, not minutes
Highlight decision points that challenge standard thinking
Keep the signal-to-noise ratio high
Focus on insights that drive real change
Organize for clarity and future reference
Balance tactical details with strategic vision

Note: If the discussion lacks substantial decision points or insights, flag it for deeper exploration next time.`,
		icon: IconNotes,
		id: "meeting-notes",
		title: t`Meeting Notes`,
	},
	{
		content: t`Develop a strategic framework that drives meaningful outcomes. Please:

Identify core objectives and their interdependencies
Map out implementation pathways with realistic timelines
Anticipate potential obstacles and mitigation strategies
Define clear metrics for success beyond vanity indicators
Highlight resource requirements and allocation priorities
Structure the plan for both immediate action and long-term vision
Include decision gates and pivot points

Note: Focus on strategies that create sustainable competitive advantages, not just incremental improvements.`,
		icon: IconBulb,
		id: "strategic-planning",
		title: t`Strategic Planning`,
	},
];

export const quickAccessTemplates = Templates.slice(0, 3);
