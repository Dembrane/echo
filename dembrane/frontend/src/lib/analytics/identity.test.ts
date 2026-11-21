import { describe, expect, it, vi } from "vitest";
import {
	hostDistinctId,
	type IdentityClient,
	identifyHost,
	type KeyValueStore,
} from "./identity";

function client(distinctId: string, loaded = true) {
	let current = distinctId;
	const ph = {
		__loaded: loaded,
		alias: vi.fn(),
		get_distinct_id: vi.fn(() => current),
		identify: vi.fn((id: string) => {
			current = id;
		}),
		setPersonProperties: vi.fn(),
	};
	return ph as typeof ph & IdentityClient;
}

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => {
			data.set(k, v);
		},
	};
}

describe("hostDistinctId", () => {
	it("is the email, trimmed and lowercased", () => {
		expect(hostDistinctId("  Ana@Example.NL ")).toBe("ana@example.nl");
		expect(hostDistinctId("")).toBeNull();
		expect(hostDistinctId(null)).toBeNull();
	});
});

describe("identifyHost", () => {
	const host = {
		directusUserId: "d-1",
		email: "Ana@Example.nl",
		isInvited: false,
		orgId: "o-1",
	};
	const props = { email: "ana@example.nl", is_invited: false, org_id: "o-1" };

	it("identifies a new host by lowercased email with the person properties", () => {
		const ph = client("anon-123");
		identifyHost(ph, host, memoryStore());
		expect(ph.identify).toHaveBeenCalledWith("ana@example.nl", props);
		// The server sends some events under the Directus id: alias it onto the person.
		expect(ph.alias).toHaveBeenCalledWith("d-1", "ana@example.nl");
	});

	it("keeps an existing host's person and only updates properties", () => {
		const ph = client("ana@example.nl");
		identifyHost(ph, host, memoryStore());
		expect(ph.identify).not.toHaveBeenCalled();
		expect(ph.setPersonProperties).toHaveBeenCalledWith(props);
	});

	it("aliases the lowercased email onto a person identified with the typed case", () => {
		const ph = client("Ana@Example.nl");
		identifyHost(ph, host, memoryStore());
		expect(ph.identify).not.toHaveBeenCalled();
		expect(ph.alias).toHaveBeenCalledWith("ana@example.nl", "Ana@Example.nl");
		expect(ph.setPersonProperties).toHaveBeenCalledWith(props);
	});

	it("aliases the Directus id once per browser", () => {
		const store = memoryStore();
		const ph = client("ana@example.nl");
		identifyHost(ph, host, store);
		identifyHost(ph, host, store);
		expect(ph.alias).toHaveBeenCalledTimes(1);
	});

	it("still aliases when storage is blocked", () => {
		const blocked: KeyValueStore = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		const ph = client("ana@example.nl");
		expect(() => identifyHost(ph, host, blocked)).not.toThrow();
		expect(ph.alias).toHaveBeenCalledWith("d-1", "ana@example.nl");
	});

	it("leaves out properties it does not know", () => {
		const ph = client("anon");
		identifyHost(ph, { email: "b@x.nl" }, memoryStore());
		expect(ph.identify).toHaveBeenCalledWith("b@x.nl", { email: "b@x.nl" });
		expect(ph.alias).not.toHaveBeenCalled();
	});

	it("does nothing when PostHog is not initialised or there is no email", () => {
		const off = client("anon", false);
		identifyHost(off, host, memoryStore());
		identifyHost(null, host, memoryStore());
		const on = client("anon");
		identifyHost(on, { email: "  " }, memoryStore());
		expect(off.identify).not.toHaveBeenCalled();
		expect(on.identify).not.toHaveBeenCalled();
		expect(on.alias).not.toHaveBeenCalled();
	});
});
