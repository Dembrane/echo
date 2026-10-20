import { expect, test } from "bun:test";
import { verifyFullUrl } from "../src/queue";

test("the modes node-postgres already reads as verify-full are named verify-full", () => {
  for (const mode of ["prefer", "require", "verify-ca"])
    expect(verifyFullUrl(`postgres://u:p@h:5432/d?sslmode=${mode}&x=1`)).toBe(
      "postgres://u:p@h:5432/d?sslmode=verify-full&x=1",
    );
});

test("every other URL is left as it is", () => {
  for (const url of [
    "postgres://u:p@h/d",
    "postgres://u:p@h/d?sslmode=disable",
    "postgres://u:p@h/d?sslmode=verify-full",
    "postgres://u:p@h/d?sslmode=require&uselibpqcompat=true",
    "postgres://u:p@/d?host=/cloudsql/x:y:z",
    "not a url",
  ])
    expect(verifyFullUrl(url)).toBe(url);
});
