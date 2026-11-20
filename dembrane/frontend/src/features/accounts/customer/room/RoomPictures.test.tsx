// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RoomPersonT } from "../../contract/contract.gen";
import { RoomPictures as RoomPicturesComponent } from "./RoomPictures";

// The small pictures at the top corner of the room's pages: RoomPictures({ people, onAdd }).
// imported up front, so no test is timed on loading it
const load = async () => RoomPicturesComponent;

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
	window.matchMedia ??= ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const person = (
	name: string,
	over: Partial<RoomPersonT> = {},
): RoomPersonT => ({
	app_user_id: null,
	email: `${name.split(" ")[0]?.toLowerCase()}@example-town.example`,
	id: null,
	invited_at: null,
	invited_by: null,
	labels: [],
	labels_answered_at: null,
	may_relabel: false,
	may_remove: false,
	name,
	org_role: "member",
	other: null,
	room: "by_invite",
	signs: [],
	status: "member",
	...over,
});

const people = [
	person("Robin Example", {
		labels: ["go_ahead"],
		org_role: "admin",
		room: "by_role",
	}),
	person("Noor Example", { org_role: null, status: "invited" }),
	person("Kim Example", { room: "none" }),
];

const show = async () => {
	const RoomPictures = await load();
	const onAdd = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<RoomPictures people={people} onAdd={onAdd} />
			</MantineProvider>
		</I18nProvider>,
	);
	return onAdd;
};

describe("the room's pictures", () => {
	it("shows the people in the room only: joined bright, invited dimmed with a tooltip saying so", async () => {
		await show();
		const pics = screen.getAllByTestId("room-picture");
		expect(pics).toHaveLength(2);
		const robin = pics.find((p) =>
			p.getAttribute("aria-label")?.startsWith("Robin"),
		) as HTMLElement;
		const noor = pics.find((p) =>
			p.getAttribute("aria-label")?.startsWith("Noor"),
		) as HTMLElement;
		expect(robin.getAttribute("data-joined")).toBe("yes");
		expect(robin.getAttribute("aria-label")).toBe("Robin Example");
		expect(noor.getAttribute("data-joined")).toBe("no");
		expect(noor.getAttribute("aria-label")).toBe(
			"Noor Example · invited, not joined yet",
		);
	});

	it("never claims who has seen anything", async () => {
		await show();
		const root = screen.getByTestId("room-pictures");
		const said = [
			root.textContent ?? "",
			...[...root.querySelectorAll("[aria-label]")].map(
				(e) => e.getAttribute("aria-label") ?? "",
			),
			root.getAttribute("aria-label") ?? "",
		].join(" ");
		expect(said).not.toMatch(/seen|been here|last here|viewer/i);
	});

	it("ends with a '+' that opens the add flow, and opens no menu", async () => {
		const onAdd = await show();
		fireEvent.click(screen.getByTestId("room-pictures-add"));
		expect(onAdd).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});
});
