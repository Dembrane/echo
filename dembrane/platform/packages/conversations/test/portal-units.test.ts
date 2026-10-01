import { expect, test } from "bun:test";
import { ForbiddenError, UnauthenticatedError } from "@dembrane/core";
import { AudioUrls, sanitizeFilenameComponent } from "../src/audio-urls";
import { ParticipantTokens } from "../src/participant-token";

const C = "c1000000-0000-4000-8000-000000000001";
const P = "f0000000-0000-4000-8000-000000000001";

test("a participant token names one conversation and project and cannot be forged", () => {
  const t = new ParticipantTokens("s".repeat(48), false);
  const token = t.issue({ conversationId: C, projectId: P });
  expect(t.read(token)).toEqual({ conversationId: C, projectId: P });
  expect(t.check(token, C, P)).toBe(true);
  expect(() => t.check(token, "other", P)).toThrow(ForbiddenError);
  expect(() => t.check(token, C, "other")).toThrow(ForbiddenError);
  expect(() => t.check(`${token}x`, C)).toThrow(ForbiddenError);
  expect(new ParticipantTokens("x".repeat(48), false).read(token)).toBeNull();
});

test("without a token the conversation id still works, until tokens are required", () => {
  expect(new ParticipantTokens("s".repeat(48), false).check(undefined, C)).toBe(false);
  expect(() => new ParticipantTokens("s".repeat(48), true).check(undefined, C)).toThrow(
    UnauthenticatedError,
  );
});

test("stored audio paths round-trip to keys the way get_sanitized_s3_key parsed them", () => {
  const u = new AudioUrls("https://ams3.digitaloceanspaces.com", "dembrane");
  const key = `conversation/${C}/chunks/x-a.webm`;
  expect(u.fileUrl(key)).toBe(`https://ams3.digitaloceanspaces.com/dembrane/${key}`);
  expect(u.keyOf(u.fileUrl(key))).toBe(key);
  expect(u.keyOf(`${u.fileUrl(key)}?X-Amz-Signature=abc`)).toBe(key);
  expect(u.keyOf(`https://other.example/bucket/${key}`)).toBe(key);
  expect(u.keyOf(`/${key}`)).toBe(key);
  expect(u.keyOf("a.webm")).toBe("a.webm");
  expect(() => u.keyOf("../etc/passwd")).toThrow("path traversal");
  expect(() => u.keyOf(`${u.fileUrl("")}../x`)).toThrow("path traversal");
  expect(() => u.keyOf("")).toThrow("Empty file name");
});

test("file name components keep letters, digits, dash and underscore", () => {
  expect(sanitizeFilenameComponent("c1-ä_b/../x.mp3")).toBe("c1-ä_bxmp3");
});
