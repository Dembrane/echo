import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { RouteName } from "../contract/contract.gen";
import {
	AccountsApiError,
	apiUrl,
	type CallOptions,
	call,
	FIXTURE_MODE,
	fetchPdf,
	type RequestOf,
	type ResponseOf,
} from "./client";

/**
 * React Query over the accounts client. One key space: a customer write refreshes the
 * customer page and any open document, a staff write refreshes the card and the list.
 */
export const accountKeys = {
	all: ["accounts"] as const,
	card: (orgId: string) => ["accounts", "staff", "card", orgId] as const,
	doc: (orgId: string, docId: string, staff: boolean) =>
		["accounts", "doc", orgId, docId, staff ? "staff" : "member"] as const,
	fields: (orgId: string, docId: string) =>
		["accounts", "fields", orgId, docId] as const,
	list: (stage: string | null) =>
		["accounts", "staff", "list", stage ?? "all"] as const,
	page: (orgId: string) => ["accounts", "page", orgId] as const,
};

export const useAccountPage = (orgId: string | undefined) =>
	useQuery({
		enabled: Boolean(orgId),
		queryFn: () => call("accountPage", { params: { orgId: orgId as string } }),
		queryKey: accountKeys.page(orgId ?? ""),
	});

export const useDocument = (
	orgId: string | undefined,
	docId: string | undefined,
	staff = false,
) =>
	useQuery({
		enabled: Boolean(orgId && docId),
		queryFn: () =>
			call(staff ? "staffReadDocument" : "readDocument", {
				params: { docId: docId as string, orgId: orgId as string },
			}),
		queryKey: accountKeys.doc(orgId ?? "", docId ?? "", staff),
	});

export const useAccountList = (dealStage: string | null, q = "") =>
	useQuery({
		// Keeps the rows while a new search loads, so the table does not flash empty.
		placeholderData: (previous) => previous,
		queryFn: () =>
			call("listAccounts", {
				query: {
					deal_stage: dealStage ?? undefined,
					limit: 200,
					q: q || undefined,
				},
			}),
		queryKey: [...accountKeys.list(dealStage), q],
	});

export const useAccountCard = (orgId: string | undefined) =>
	useQuery({
		enabled: Boolean(orgId),
		queryFn: () => call("accountCard", { params: { orgId: orgId as string } }),
		queryKey: accountKeys.card(orgId ?? ""),
	});

/**
 * A mutation over one route. Everything under ["accounts"] is refreshed after it: the
 * page, the card and the list are small, and a stale task list after a sign is the one
 * thing this screen must never show.
 */
export function useAccountsMutation<N extends RouteName>(
	name: N,
	params: Record<string, string> = {},
) {
	const queryClient = useQueryClient();
	return useMutation<
		ResponseOf<N>,
		Error,
		{ body?: RequestOf<N>; params?: Record<string, string> }
	>({
		mutationFn: ({ body, params: extra }) =>
			call(name, { body, params: { ...params, ...extra } } as CallOptions<N>),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: accountKeys.all }),
	});
}

/**
 * An href for a document PDF. Against the API it is the file URL itself (the session
 * cookie authorises it); in fixture mode the file is built in the page, so the href is a
 * blob URL that appears once it is ready.
 */
export function usePdfHref(url: string | null | undefined): string | null {
	const [blobHref, setBlobHref] = useState<string | null>(null);
	useEffect(() => {
		if (!FIXTURE_MODE || !url) return;
		let revoked = false;
		let href: string | null = null;
		fetchPdf(url).then((bytes) => {
			if (revoked) return;
			href = URL.createObjectURL(
				new Blob([bytes as BlobPart], { type: "application/pdf" }),
			);
			setBlobHref(href);
		});
		return () => {
			revoked = true;
			if (href) URL.revokeObjectURL(href);
		};
	}, [url]);
	if (!url) return null;
	if (!FIXTURE_MODE) return url.startsWith("/api/") ? apiUrl(url) : url;
	return blobHref;
}

/**
 * An href for a legal text a document incorporates (a pin's text_url). Against the API it
 * is the route itself; in fixture mode there is no server, so it is a small page built here.
 */
export function useLegalHref(pin: {
	text_url: string | null;
	version: string;
	sha256: string;
}): string | null {
	const [blobHref, setBlobHref] = useState<string | null>(null);
	useEffect(() => {
		if (!FIXTURE_MODE || !pin.text_url) return;
		const href = URL.createObjectURL(
			new Blob(
				[
					`<!doctype html><meta charset="utf-8"><title>Version ${pin.version}</title><body style="font:16px/1.5 system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem"><h1>Sample legal text</h1><p>Version ${pin.version}</p><p style="color:#666;word-break:break-all">SHA-256 of the text: ${pin.sha256}</p><p>This is the text as it was pinned when the document was sent.</p>`,
				],
				{ type: "text/html" },
			),
		);
		setBlobHref(href);
		return () => URL.revokeObjectURL(href);
	}, [pin.text_url, pin.version, pin.sha256]);
	if (!pin.text_url) return null;
	return FIXTURE_MODE ? blobHref : apiUrl(pin.text_url);
}

/**
 * The bytes of a document's PDF for pdf.js. A document's file never changes once sent;
 * a draft's does when staff change it, so its sha256 goes in as `version`.
 */
export const usePdfData = (
	url: string | null | undefined,
	version: string | null = null,
) =>
	useQuery({
		enabled: Boolean(url),
		queryFn: () => fetchPdf(url as string),
		// Outside the ["accounts"] prefix, so a write does not refetch and re-render the pages.
		queryKey: ["accounts-pdf", url ?? "", version ?? ""],
		// A missing file (404) will not appear by asking again; other failures get one retry.
		retry: (count, error) =>
			!(error instanceof AccountsApiError && error.status === 404) && count < 1,
		staleTime: Number.POSITIVE_INFINITY,
	});
