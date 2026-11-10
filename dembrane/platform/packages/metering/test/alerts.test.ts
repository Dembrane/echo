import { describe, expect, test } from "bun:test";
import {
  AI_COST_ALERT_CODE,
  AI_COST_ALERT_MAX_CHARS,
  type CostAlertMessage,
  costAlertMessage,
  postCostAlert,
} from "../src";

function fakeLogger() {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const at =
    (level: string) =>
    (fields: Record<string, unknown>, message = "") =>
      lines.push({ level, fields, message });
  return {
    lines,
    logger: { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") } as never,
  };
}

const AT = new Date("2026-11-05T03:15:00Z");

describe("AI cost alerts", () => {
  test("one alert is one dembrane_ai_cost_alert_v1 message carrying its text and day", () => {
    const m = costAlertMessage("USD to EUR rate moved 2.5%.", AT);
    expect(AI_COST_ALERT_CODE).toBe("dembrane_ai_cost_alert_v1");
    expect(m.code).toBe("dembrane_ai_cost_alert_v1");
    expect(m.json).toEqual({ text: "USD to EUR rate moved 2.5%.", day: "2026-11-05" });
    expect(m.id).toMatch(/^2026-11-05-[0-9a-f]{16}$/);
  });

  test("the id is stable for the same text on the same UTC day and differs otherwise", () => {
    const a = costAlertMessage("No AI price for vertex/x.", AT);
    expect(costAlertMessage("No AI price for vertex/x.", new Date("2026-11-05T23:59:59Z")).id).toBe(
      a.id,
    );
    expect(costAlertMessage("No AI price for vertex/y.", AT).id).not.toBe(a.id);
    expect(
      costAlertMessage("No AI price for vertex/x.", new Date("2026-11-06T00:00:00Z")).id,
    ).not.toBe(a.id);
  });

  test("the payload carries the day, so sam's content dedupe holds within a day and not across days", () => {
    const a = costAlertMessage("No AI price for vertex/x.", AT);
    const later = costAlertMessage("No AI price for vertex/x.", new Date("2026-11-05T23:00:00Z"));
    const next = costAlertMessage("No AI price for vertex/x.", new Date("2026-11-06T00:00:00Z"));
    expect(JSON.stringify(later.json)).toBe(JSON.stringify(a.json));
    expect(next.json).toEqual({ text: "No AI price for vertex/x.", day: "2026-11-06" });
    expect(JSON.stringify(next.json)).not.toBe(JSON.stringify(a.json));
  });

  test("a text over the bound is cut to it, so sam never refuses it for its length", () => {
    const m = costAlertMessage("x".repeat(AI_COST_ALERT_MAX_CHARS + 50), AT);
    const text = m.json.text;
    expect([...text]).toHaveLength(AI_COST_ALERT_MAX_CHARS);
    expect(text.endsWith("…")).toBe(true);
    expect(costAlertMessage("y".repeat(AI_COST_ALERT_MAX_CHARS), AT).json.text).toBe(
      "y".repeat(AI_COST_ALERT_MAX_CHARS),
    );
  });

  test("an alert is logged and handed to the sink", async () => {
    const sent: CostAlertMessage[] = [];
    const { logger, lines } = fakeLogger();
    await postCostAlert(async (m) => void sent.push(m), "Large change: x", logger, AT);
    expect(sent).toEqual([costAlertMessage("Large change: x", AT)]);
    expect(lines.filter((l) => l.fields.signal === "metering.cost_alert")).toHaveLength(1);
    expect(lines[0]?.fields.text).toBe("Large change: x");
  });

  test("without a sink the alert is only logged", async () => {
    const { logger, lines } = fakeLogger();
    await postCostAlert(null, "Large change: x", logger, AT);
    expect(lines.map((l) => [l.level, l.fields.signal])).toEqual([["info", "metering.cost_alert"]]);
  });

  test("a sink that fails is logged and never throws", async () => {
    const { logger, lines } = fakeLogger();
    await postCostAlert(
      async () => {
        throw new Error("queue not started");
      },
      "x",
      logger,
      AT,
    );
    expect(lines.some((l) => l.level === "warn")).toBe(true);
  });
});
