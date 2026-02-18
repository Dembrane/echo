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

export const agenticQuickAccessTemplates: Template[] = [
	{
		content: `Summarize the most important project-wide themes and patterns.

Ask clarifying questions first if the scope, audience, or output format is unclear.

Please:
- Synthesize across conversations instead of listing one-by-one.
- Highlight non-obvious patterns, tensions, and implications.
- Ground each major claim in available evidence and cite conversation IDs when possible.
- Flag uncertainty and evidence gaps clearly.
- End with suggested next questions that would deepen the analysis.`,
		icon: IconNotes,
		id: "project-meta-summary",
		title: t`Project Meta Summary`,
	},
	{
		content: `Compare and contrast key perspectives across this project.

Ask clarifying questions first if I have not specified what to compare.

Please:
- Choose the 2-4 most meaningful dimensions of comparison.
- Focus on substantive differences, not superficial wording differences.
- Show where viewpoints converge, diverge, and conflict.
- Explain why those differences matter for decisions or strategy.
- Call out missing evidence and what additional data would resolve ambiguity.`,
		icon: IconCalculator,
		id: "compare-contrast-insights",
		title: t`Compare & Contrast Insights`,
	},
	{
		content: `Highlight a specific concept across the project.

Ask clarifying questions first if the concept, scope, or angle is unclear.

Please:
- Define the concept clearly in this project context.
- Pull the strongest supporting evidence and relevant counterexamples.
- Show how different participants frame or contest the concept.
- Explain practical implications and where this concept affects decisions.
- Flag unresolved questions and suggest what to examine next.`,
		icon: IconNotes,
		id: "highlight-specific-concept",
		title: t`Highlight specific Concept`,
	},
];
