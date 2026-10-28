// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { scrollToTranscriptEnd } from "./scrollToTranscriptEnd";

describe("scrollToTranscriptEnd", () => {
	it("scrolls at once when nothing is left to load", async () => {
		const fetchNextPage = vi.fn();
		const scrollToEnd = vi.fn();
		await scrollToTranscriptEnd({
			fetchNextPage,
			hasNextPage: false,
			scrollToEnd,
		});
		expect(fetchNextPage).not.toHaveBeenCalled();
		expect(scrollToEnd).toHaveBeenCalledTimes(1);
	});

	it("loads every remaining page, then scrolls once", async () => {
		const order: string[] = [];
		const fetchNextPage = vi
			.fn()
			.mockImplementationOnce(async () => {
				order.push("page");
				return { hasNextPage: true };
			})
			.mockImplementationOnce(async () => {
				order.push("page");
				return { hasNextPage: true };
			})
			.mockImplementationOnce(async () => {
				order.push("page");
				return { hasNextPage: false };
			});
		await scrollToTranscriptEnd({
			fetchNextPage,
			hasNextPage: true,
			scrollToEnd: () => order.push("scroll"),
		});
		expect(fetchNextPage).toHaveBeenCalledTimes(3);
		expect(order).toEqual(["page", "page", "page", "scroll"]);
	});

	it("stops after the page limit and still scrolls", async () => {
		const fetchNextPage = vi.fn(async () => ({ hasNextPage: true }));
		const scrollToEnd = vi.fn();
		await scrollToTranscriptEnd({
			fetchNextPage,
			hasNextPage: true,
			maxPages: 4,
			scrollToEnd,
		});
		expect(fetchNextPage).toHaveBeenCalledTimes(4);
		expect(scrollToEnd).toHaveBeenCalledTimes(1);
	});

	it("does not retry a failed page and still scrolls", async () => {
		const fetchNextPage = vi.fn(async () => ({
			hasNextPage: true,
			isError: true,
		}));
		const scrollToEnd = vi.fn();
		await scrollToTranscriptEnd({
			fetchNextPage,
			hasNextPage: true,
			scrollToEnd,
		});
		expect(fetchNextPage).toHaveBeenCalledTimes(1);
		expect(scrollToEnd).toHaveBeenCalledTimes(1);
	});
});
