import { describe, expect, it } from "vitest";
import type { DocumentFieldT } from "../contract/contract.gen";
import { offerDetail } from "../contract/fixtures.gen";
import {
	asksDpaQuestion,
	confirmationTemplate,
	fillConfirmation,
	isComplete,
	isFilled,
	nextRequired,
	nextStop,
	orderFields,
	previousField,
	progress,
	requestValues,
	todayForDocument,
	type Values,
} from "./fieldStepper";

// The offer fixture: name, organisation, address, VAT number (optional), role, date, signature.
const fields = offerDetail.fields;
const at = (i: number): DocumentFieldT => {
	const f = orderFields(fields)[i];
	if (!f) throw new Error(`no field ${i}`);
	return f;
};
const [name, org, address, vat, role, date, signature] = [
	0, 1, 2, 3, 4, 5, 6,
].map(at) as [
	DocumentFieldT,
	DocumentFieldT,
	DocumentFieldT,
	DocumentFieldT,
	DocumentFieldT,
	DocumentFieldT,
	DocumentFieldT,
];
const none = { initials: false, signature: false };
const signed = { initials: false, signature: true };

const filled: Values = {
	[name.id]: "Robin Example",
	[org.id]: "Example Town Council (sample)",
	[address.id]: "Example Street 1",
	[role.id]: "Wethouder",
	[date.id]: "28-09-2026",
};

describe("orderFields", () => {
	it("walks by sort, then page and position", () => {
		const shuffled = [...fields].reverse();
		expect(orderFields(shuffled).map((f) => f.id)).toEqual(
			fields.map((f) => f.id),
		);
		const a = { ...at(0), id: "a", page: 2, sort: 0, y: 0.5 };
		const b = { ...at(0), id: "b", page: 1, sort: 0, y: 0.9 };
		expect(orderFields([a, b]).map((f) => f.id)).toEqual(["b", "a"]);
	});
});

describe("isFilled", () => {
	it("needs non-blank text, a true checkbox, or an image", () => {
		expect(isFilled(name, { [name.id]: "  " }, none)).toBe(false);
		expect(isFilled(name, { [name.id]: "Sameer" }, none)).toBe(true);
		expect(isFilled(signature, {}, none)).toBe(false);
		expect(isFilled(signature, {}, signed)).toBe(true);
		const box = { ...name, kind: "checkbox" as const };
		expect(isFilled(box, { [box.id]: false }, none)).toBe(false);
		expect(isFilled(box, { [box.id]: true }, none)).toBe(true);
	});

	it("lets initials reuse the signature image", () => {
		const initials = { ...signature, kind: "initials" as const };
		expect(isFilled(initials, {}, none)).toBe(false);
		expect(isFilled(initials, {}, signed)).toBe(true);
		expect(isFilled(initials, {}, { initials: true, signature: false })).toBe(
			true,
		);
	});
});

describe("nextRequired", () => {
	it("starts at the first empty required field and skips optional ones", () => {
		expect(nextRequired(fields, {}, none)?.id).toBe(name.id);
		expect(
			nextRequired(
				fields,
				{ [name.id]: "x", [org.id]: "y", [address.id]: "z" },
				none,
			)?.id,
		).toBe(role.id);
	});

	it("looks forward from the current field and wraps", () => {
		expect(nextRequired(fields, {}, none, role.id)?.id).toBe(date.id);
		expect(nextRequired(fields, {}, none, signature.id)?.id).toBe(name.id);
	});

	it("is null once every required field is filled", () => {
		expect(nextRequired(fields, filled, none)?.id).toBe(signature.id);
		expect(nextRequired(fields, filled, signed)).toBeNull();
		expect(isComplete(fields, filled, signed)).toBe(true);
		expect(isComplete(fields, filled, none)).toBe(false);
	});
});

describe("nextStop (the Next button)", () => {
	it("shows every field once, prefilled and optional ones included", () => {
		const visited = new Set([name.id]);
		expect(nextStop(fields, filled, none, name.id, visited)?.id).toBe(org.id);
		visited.add(org.id).add(address.id);
		expect(nextStop(fields, filled, none, address.id, visited)?.id).toBe(
			vat.id,
		);
		visited.add(vat.id);
		expect(nextStop(fields, filled, none, vat.id, visited)?.id).toBe(role.id);
	});

	it("after the first pass, only returns to required fields still empty", () => {
		const visited = new Set(fields.map((f) => f.id));
		expect(nextStop(fields, filled, none, name.id, visited)?.id).toBe(
			signature.id,
		);
		expect(nextStop(fields, filled, none, signature.id, visited)).toBeNull();
		expect(nextStop(fields, filled, signed, null, visited)).toBeNull();
		const missingRole = { ...filled, [role.id]: "" };
		expect(
			nextStop(fields, missingRole, signed, signature.id, visited)?.id,
		).toBe(role.id);
	});

	it("walks every field from the start, then ends", () => {
		const visited = new Set<string>();
		const values: Values = { [date.id]: "28-09-2026" };
		let images = none;
		const walked: string[] = [];
		let current: DocumentFieldT | null = nextStop(
			fields,
			values,
			images,
			null,
			visited,
		);
		while (current) {
			walked.push(current.id);
			visited.add(current.id);
			if (current.kind === "signature") images = signed;
			else if (current.required) values[current.id] = values[current.id] || "x";
			current = nextStop(fields, values, images, current.id, visited);
		}
		expect(walked).toEqual(orderFields(fields).map((f) => f.id));
		expect(isComplete(fields, values, images)).toBe(true);
	});
});

describe("previousField and progress", () => {
	it("steps back in walk order", () => {
		expect(previousField(fields, org.id)?.id).toBe(name.id);
		expect(previousField(fields, name.id)).toBeNull();
		expect(previousField(fields, null)?.id).toBe(signature.id);
	});

	it("counts required fields only", () => {
		expect(progress(fields, {}, none)).toEqual({ done: 0, total: 6 });
		expect(progress(fields, filled, signed)).toEqual({ done: 6, total: 6 });
		expect(progress(fields, { ...filled, [vat.id]: "NL1" }, none)).toEqual({
			done: 5,
			total: 6,
		});
	});
});

describe("the confirmation", () => {
	it("fills name, role and organisation as the server does", () => {
		const template = confirmationTemplate(offerDetail, true) as string;
		const text = fillConfirmation(template, fields, filled);
		expect(
			text.startsWith(
				"Ik, Robin Example, Wethouder, bevestig dat ik namens Example Town Council (sample) mag tekenen",
			),
		).toBe(true);
		expect(text).not.toMatch(/\{(name|role|organisation)\}/);
	});

	it("uses the not-authorised sentence when the signer may not agree to data processing", () => {
		expect(confirmationTemplate(offerDetail, false)).toBe(
			offerDetail.confirmation?.dpa_not_authorised,
		);
		expect(confirmationTemplate({ confirmation: null }, true)).toBeNull();
	});

	it("asks the data processing question on offers only", () => {
		expect(asksDpaQuestion(offerDetail)).toBe(true);
		expect(asksDpaQuestion({ ...offerDetail, kind: "dpa" })).toBe(false);
		expect(
			asksDpaQuestion({
				...offerDetail,
				confirmation: { dpa_authorised: "x", dpa_not_authorised: null },
			}),
		).toBe(false);
	});
});

describe("requestValues", () => {
	it("sends trimmed text, booleans for checkboxes, and no image fields", () => {
		const box = { ...name, id: "box", kind: "checkbox" as const };
		const out = requestValues([...fields, box], {
			...filled,
			[name.id]: " Sameer ",
			[vat.id]: "",
		});
		expect(out[name.id]).toBe("Sameer");
		expect(out[vat.id]).toBeUndefined();
		expect(out[signature.id]).toBeUndefined();
		expect(out.box).toBe(false);
	});

	it("prints dates day-month-year", () => {
		expect(todayForDocument(new Date(2026, 8, 3))).toBe("03-09-2026");
	});
});
