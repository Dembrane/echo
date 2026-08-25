/**
 * Where the pricing configurator books a call.
 *
 * The URL is the dembrane team round robin booking form. It replaces
 * `team/dembrane/plan-event`.
 *
 * The embed is the primary route. `BOOK_A_CALL` is the fallback, opened in a new
 * tab when the iframe does not load. The fallback is a normal screen, not an error.
 *
 * The embed, with no extra dependency (`@calcom/embed-react` is not installed):
 * load `EMBED_SCRIPT` once, then
 *   Cal("init", BookingLinks.EMBED_NAMESPACE, { origin: "https://app.cal.com" });
 *   Cal.ns[BookingLinks.EMBED_NAMESPACE]("inline", {
 *     elementOrSelector: "#cal-booking",
 *     calLink: BookingLinks.CAL_LINK,
 *     config: { layout: "month_view" },
 *   });
 * The CSP does not allow cal.com yet, so every person lands on the fallback until
 * `frame-src`, `script-src` and `connect-src` in `vercel.json` list it.
 */
export const BookingLinks = {
	/** Fallback route: the plain page, opened in a new tab. */
	BOOK_A_CALL: "https://cal.com/team/dembrane/discuss-your-needs",
	/** Primary route: the same event type, as the embed names it. */
	CAL_LINK: "team/dembrane/discuss-your-needs",
	/** Keeps this embed separate from any other embed on the page. */
	EMBED_NAMESPACE: "discuss-your-needs",
	EMBED_SCRIPT: "https://app.cal.com/embed/embed.js",
} as const;

/**
 * Who the person books with.
 *
 * A named human outperforms "a dembrane team member": people book calls with
 * people, not with teams. The booking step reads the host name from here.
 *
 * `photo` is null and stays null until an asset exists in the repo. A made up
 * one would be worse than none.
 *
 * `null` for the whole object is a supported state, not a bug: the booking
 * step then says "the dembrane team" in both of its lines.
 */
export type BookingHostInfo = {
	name: string;
	photo: string | null;
};

export const BookingHost: BookingHostInfo | null = {
	name: "Eve",
	photo: null,
};
