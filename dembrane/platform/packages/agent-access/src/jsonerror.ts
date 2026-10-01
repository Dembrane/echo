/**
 * The message pydantic_core's JSON parser gives for a body that is not valid JSON
 * ("expected value at line 1 column 1", "EOF while parsing an object at line 1 column 1").
 * The Python MCP transport and the client registration endpoint put it in their error
 * answers; the platform's JSON.parse words failures differently, so the scan below finds
 * the same first fault and names it the same way. Only called on bodies that failed to parse.
 */
export function jsonErrorText(text: string): string {
  let i = 0;
  const where = (pos: number, eof: boolean) => {
    const before = text.slice(0, pos);
    const line = before.split("\n").length;
    const lineStart = before.lastIndexOf("\n") + 1;
    return `line ${line} column ${eof ? pos - lineStart : pos - lineStart + 1}`;
  };
  class Fault extends Error {}
  const fail = (msg: string, pos: number, eof = false): never => {
    throw new Fault(`${msg} at ${where(pos, eof)}`);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i] as string)) i++;
  };
  const eof = () => i >= text.length;

  const value = (): void => {
    ws();
    if (eof()) fail("EOF while parsing a value", i, true);
    const c = text[i] as string;
    if (c === "{") object();
    else if (c === "[") array();
    else if (c === '"') string();
    else if (c === "t" || c === "f" || c === "n")
      ident(c === "t" ? "true" : c === "f" ? "false" : "null");
    else if (c === "-" || (c >= "0" && c <= "9")) number();
    else fail("expected value", i);
  };
  const ident = (word: string) => {
    for (const ch of word) {
      if (eof()) fail("EOF while parsing a value", i, true);
      if (text[i] !== ch) fail("expected ident", i);
      i++;
    }
  };
  const number = () => {
    if (text[i] === "-") i++;
    if (eof()) fail("EOF while parsing a value", i, true);
    if (text[i] === "0") {
      i++;
      if (!eof() && /[0-9]/.test(text[i] as string)) fail("invalid number", i);
    } else if (/[0-9]/.test(text[i] as string)) {
      while (!eof() && /[0-9]/.test(text[i] as string)) i++;
    } else fail("invalid number", i);
    if (text[i] === ".") {
      i++;
      if (eof()) fail("EOF while parsing a value", i, true);
      if (!/[0-9]/.test(text[i] as string)) fail("invalid number", i);
      while (!eof() && /[0-9]/.test(text[i] as string)) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (eof()) fail("EOF while parsing a value", i, true);
      if (!/[0-9]/.test(text[i] as string)) fail("invalid number", i);
      while (!eof() && /[0-9]/.test(text[i] as string)) i++;
    }
  };
  const string = () => {
    i++;
    while (true) {
      if (eof()) fail("EOF while parsing a string", i, true);
      const c = text[i] as string;
      if (c === '"') {
        i++;
        return;
      }
      if (c === "\\") i += 2;
      else if (c.charCodeAt(0) < 0x20)
        fail("control character (\\u0000-\\u001F) found while parsing a string", i);
      else i++;
    }
  };
  const object = () => {
    i++;
    ws();
    if (eof()) fail("EOF while parsing an object", i, true);
    if (text[i] === "}") {
      i++;
      return;
    }
    while (true) {
      ws();
      if (eof()) fail("EOF while parsing an object", i, true);
      if (text[i] !== '"') fail("key must be a string", i);
      string();
      ws();
      if (eof()) fail("EOF while parsing an object", i, true);
      if (text[i] !== ":") fail("expected `:`", i);
      i++;
      value();
      ws();
      if (eof()) fail("EOF while parsing an object", i, true);
      if (text[i] === "}") {
        i++;
        return;
      }
      if (text[i] !== ",") fail("expected `,` or `}`", i);
      i++;
      ws();
      if (text[i] === "}") fail("trailing comma", i);
    }
  };
  const array = () => {
    i++;
    ws();
    if (eof()) fail("EOF while parsing a list", i, true);
    if (text[i] === "]") {
      i++;
      return;
    }
    while (true) {
      value();
      ws();
      if (eof()) fail("EOF while parsing a list", i, true);
      if (text[i] === "]") {
        i++;
        return;
      }
      if (text[i] !== ",") fail("expected `,` or `]`", i);
      i++;
      ws();
      if (text[i] === "]") fail("trailing comma", i);
    }
  };

  try {
    value();
    ws();
    if (!eof()) fail("trailing characters", i);
  } catch (err) {
    if (err instanceof Fault) return err.message;
    throw err;
  }
  return "expected value at line 1 column 1";
}
