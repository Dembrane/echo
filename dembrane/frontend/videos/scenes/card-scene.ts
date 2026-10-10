import { type Card, playCard, showCard } from "../lib/card.ts";
import type { Lang, Scene, Text } from "../lib/scene.ts";

/** Card text still in square brackets ("[x]%", "[fill in]"), by scene id; the render lists it. */
export const PLACEHOLDERS = new Map<string, string[]>();

/** A scene that is only a card: it appears, the lines are read, it holds. */
export function cardScene(o: {
	id: string;
	since: string;
	about: string;
	card: Record<Lang, Card>;
	say: Text[];
}): Scene {
	const left = JSON.stringify([o.card, o.say]).match(
		/\[(x|[^[\]"]*(fill in|invullen)[^[\]"]*)\]/g,
	);
	if (left) PLACEHOLDERS.set(o.id, [...new Set(left)]);
	return {
		about: o.about,
		id: o.id,
		async run(ctx) {
			await playCard(ctx.page);
			await ctx.page.waitForTimeout(500);
			for (const line of o.say) await ctx.say(line);
			await ctx.page.waitForTimeout(400);
		},
		async setup(ctx) {
			await showCard(ctx.page, o.card[ctx.lang]);
		},
		since: o.since,
	};
}
