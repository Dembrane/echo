// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { PARTICIPANT_BASE_URL } from "@/config";
import { useProjectSharingLink } from "./ProjectQRCode";

// The participant link handed out for a project: its portal language, and
// where it was handed out as utm_source.
const project = (language: string) =>
	({ id: "p1", language }) as unknown as Project;

it("is nothing without a project", () => {
	const { result } = renderHook(() => useProjectSharingLink(undefined));
	expect(result.current).toBeNull();
});

it("opens the start page in the project's language, short or full code", () => {
	const short = renderHook(() => useProjectSharingLink(project("nl")));
	const full = renderHook(() => useProjectSharingLink(project("de-DE")));
	expect(short.result.current).toBe(`${PARTICIPANT_BASE_URL}/nl-NL/p1/start`);
	expect(full.result.current).toBe(`${PARTICIPANT_BASE_URL}/de-DE/p1/start`);
});

it("says where it was handed out", () => {
	const { result } = renderHook(() =>
		useProjectSharingLink(project("en"), "qr_scan"),
	);
	expect(result.current).toBe(
		`${PARTICIPANT_BASE_URL}/en-US/p1/start?utm_source=qr_scan`,
	);
});

it("follows a change of language", () => {
	const { result, rerender } = renderHook(
		({ p }) => useProjectSharingLink(p, "copy_link"),
		{ initialProps: { p: project("fr") } },
	);
	rerender({ p: project("it") });
	expect(result.current).toBe(
		`${PARTICIPANT_BASE_URL}/it-IT/p1/start?utm_source=copy_link`,
	);
});
