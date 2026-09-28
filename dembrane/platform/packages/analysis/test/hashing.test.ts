import { expect, test } from "bun:test";
import { canonicalJson, contentHash, PyFloat, pyFloatRepr } from "../src/hashing";
import vectors from "./fixtures/python-hashes.json" with { type: "json" };

// The same values the Python hashing module was given (python-hashes.json holds its output).
// Floats the Python side held as float are PyFloat here: JSON parsing cannot tell 3.0 from 3.
const cases: unknown[] = [
  { b: 1, a: [1, 2.5, "x"], c: null, d: true },
  { é: "café", ß: "Straße", Å: "Å" },
  {
    n: [
      0.1,
      new PyFloat(1e-5),
      new PyFloat(1e16),
      1.5e-7,
      123456789.125,
      -0,
      new PyFloat(3),
      new PyFloat(1e21),
      2 ** 60,
    ],
  },
  { s: 'line\nbreak\t"quote" \\ \x01 \x7f   😀' },
  { 𝒳: 1, z: 2, Z: 3, "￿": 4 },
  [],
];

test("canonical JSON and content hashes match the Python c14n-v1 output", () => {
  cases.forEach((value, i) => {
    const [json, hash] = vectors[i] as [string, string];
    expect(canonicalJson(value)).toBe(json);
    expect(contentHash(value)).toBe(hash);
  });
});

test("float repr follows Python's switch to exponents", () => {
  expect(pyFloatRepr(1)).toBe("1.0");
  expect(pyFloatRepr(0.0001)).toBe("0.0001");
  expect(pyFloatRepr(0.00001)).toBe("1e-05");
  expect(pyFloatRepr(1e15)).toBe("1000000000000000.0");
  expect(pyFloatRepr(1e16)).toBe("1e+16");
  expect(pyFloatRepr(-2.5e-10)).toBe("-2.5e-10");
  expect(() => contentHash({ x: Number.NaN })).toThrow();
});
