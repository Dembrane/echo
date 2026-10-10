import { type Card, playCard, showCard } from "../lib/card.ts";
import type { Lang, Scene, Text } from "../lib/scene.ts";

/** A scene that is only a card: it appears, the lines are read, it holds. */
export function cardScene(o: {
	id: string;
	since: string;
	about: string;
	card: Record<Lang, Card>;
	say: Text[];
}): Scene {
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
