import { expect, test } from "bun:test";
import { connect, describeDbFailure } from "../src/connection";

test("a Cloud SQL socket URL becomes a socket path, not a TCP host", () => {
  const sql = connect("postgres://u:p@localhost/echo?host=/cloudsql/proj:region:inst");
  expect(sql.options.path).toBe("/cloudsql/proj:region:inst/.s.PGSQL.5432");
  void sql.end();
});

test("a plain URL connects over TCP", () => {
  const sql = connect("postgres://u:p@db.example:6543/echo");
  expect(sql.options.path).toBeFalsy();
  expect(sql.options.host).toEqual(["db.example"]);
  void sql.end();
});

const SOCKET_URL =
  "postgres://echo_app:pw@localhost/echo?host=/cloudsql/proj:europe-west4:echo-preview";

test("a client that dialed TCP although the URL names a socket is a socket fault", () => {
  // The preview worker's crash on 2026-09-28: postgres.js opened the raw URL.
  const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
    code: "ECONNREFUSED",
    address: "127.0.0.1",
    port: 5432,
  });
  const f = describeDbFailure(err, SOCKET_URL);
  expect(f?.cause).toBe("socket");
  expect(f?.target).toBe(
    "socket /cloudsql/proj:europe-west4:echo-preview/.s.PGSQL.5432, database echo, user echo_app",
  );
  expect(f?.message).toContain("dialed TCP 127.0.0.1:5432");
  expect(f?.message).not.toContain("pw");
});

test("a missing socket, a rejected login and a silent host are each named", () => {
  const missing = Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
  expect(describeDbFailure(missing, SOCKET_URL)?.cause).toBe("socket");
  const auth = Object.assign(new Error('password authentication failed for user "echo_app"'), {
    code: "28P01",
  });
  expect(describeDbFailure(auth, SOCKET_URL)?.cause).toBe("auth");
  const host = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
    code: "ECONNREFUSED",
    address: "10.0.0.5",
    port: 5432,
  });
  const f = describeDbFailure(host, "postgres://u:p@10.0.0.5:5432/echo");
  expect(f?.cause).toBe("host");
  expect(f?.target).toBe("host 10.0.0.5:5432, database echo, user u");
});

test("the driver error inside DBOS's wrapper is what gets named", () => {
  const inner = Object.assign(new Error('database "echo" does not exist'), { code: "3D000" });
  const wrapped = Object.assign(new Error("Unable to connect to system database"), {
    error: inner,
  });
  expect(describeDbFailure(wrapped, SOCKET_URL)?.cause).toBe("database");
});

test("an error that is not about the database is left alone", () => {
  expect(describeDbFailure(new Error("no handler registered"), SOCKET_URL)).toBeNull();
});
