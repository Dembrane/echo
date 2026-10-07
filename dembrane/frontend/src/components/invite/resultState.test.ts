import { expect, it } from "vitest";
import { resultStateFor } from "./resultState";

it("an invite that waits for the recipient reads as sent", () => {
	expect(resultStateFor("invited")).toBe("sent");
	expect(resultStateFor(undefined)).toBe("sent");
});

it("a direct add reads as added, not sent", () => {
	expect(resultStateFor("added")).toBe("added");
	expect(resultStateFor("reactivated")).toBe("added");
});

it("idempotent answers keep their own states", () => {
	expect(resultStateFor("already_member")).toBe("already_member");
	expect(resultStateFor("already_invited")).toBe("already_invited");
});
