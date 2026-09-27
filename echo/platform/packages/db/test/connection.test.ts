import { expect, test } from "bun:test";
import { connect } from "../src/connection";

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
