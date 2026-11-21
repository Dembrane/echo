// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createLazyNamedRoute, createLazyRoute } from "./LazyRoute";

vi.mock("posthog-js", () => ({ default: { captureException: vi.fn() } }));

afterEach(cleanup);

const Hello = ({ name }: { name: string }) => <p>Hello {name}</p>;

it("renders the lazily loaded component with its props", async () => {
	const Lazy = createLazyNamedRoute<{ name: string }>(
		async () => ({ Hello }),
		"Hello",
		() => <p>loading</p>,
	);
	render(<Lazy name="Anna" />);
	expect(await screen.findByText("Hello Anna")).toBeTruthy();
});

it("a chunk that fails to load shows its error fallback and leaves the page standing", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const Broken = createLazyRoute<{ name: string }>(
		() =>
			Promise.reject(new Error("Failed to fetch dynamically imported module")),
		() => null,
		null,
	);
	render(
		<main>
			<p>The rest of the page</p>
			<Broken name="Anna" />
		</main>,
	);
	expect(await screen.findByText("The rest of the page")).toBeTruthy();
	await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
	expect(screen.queryByText("Hello Anna")).toBeNull();
	expect(screen.queryByText("Something went wrong")).toBeNull();
});
