import { ACCEPTED_AUDIO_FORMATS, AudioError, type Media } from "@echo/audio";
import type { Logger } from "@echo/observability";
import { Hono } from "hono";
import { z } from "zod";

const format = z.enum(ACCEPTED_AUDIO_FORMATS);
const source = z.object({ url: z.url(), format, name: z.string().optional() });
const target = z.object({ url: z.url(), contentType: z.string() });
const output = z.enum(["mp3", "ogg"]);

const schemas = {
  probe: z.object({ source }),
  "probe-url": z.object({ url: z.url() }),
  convert: z.object({ source, target, outputFormat: output }),
  split: z.object({
    source,
    pieces: z
      .array(z.object({ start: z.number().min(0), duration: z.number().positive(), target }))
      .min(1),
  }),
  merge: z.object({ sources: z.array(source).min(1), target, outputFormat: output }),
};

/**
 * The media service's HTTP surface: one ffmpeg job per request. Cloud Run runs it with
 * concurrency 1 and IAM in front (only the worker's and API's service accounts may
 * invoke it), so the app itself neither authenticates nor queues; a lock still keeps a
 * second local request from sharing the CPU with the first.
 */
export function mediaApp(media: Media, logger: Logger) {
  const app = new Hono();
  let busy: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = busy.then(fn, fn);
    busy = run.catch(() => undefined);
    return run;
  };

  app.get("/health", (c) => c.json({ status: "ok" }));

  for (const op of Object.keys(schemas) as (keyof typeof schemas)[]) {
    app.post(`/${op}`, async (c) => {
      const parsed = schemas[op].safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ kind: "value", message: parsed.error.message }, 400);
      const started = performance.now();
      try {
        const result = await oneAtATime(() => dispatch(media, op, parsed.data));
        logger.info({ op, ms: Math.round(performance.now() - started) }, "media job done");
        return c.json(result ?? null);
      } catch (err) {
        if (err instanceof AudioError) {
          logger.warn({ op, kind: err.kind, err: err.message }, "media job failed");
          // 422 for bad input the caller must not retry; 503 for what a retry can fix.
          return c.json(
            { kind: err.kind, message: err.message },
            err.kind === "transient" ? 503 : 422,
          );
        }
        logger.error({ op, err }, "media job crashed");
        return c.json({ kind: "transient", message: (err as Error).message }, 500);
      }
    });
  }
  return app;
}

function dispatch(media: Media, op: keyof typeof schemas, body: unknown): Promise<unknown> {
  switch (op) {
    case "probe":
      return media.probe((body as z.output<typeof schemas.probe>).source);
    case "probe-url":
      return media.probeUrl((body as z.output<(typeof schemas)["probe-url"]>).url);
    case "convert":
      return media.convert(body as z.output<typeof schemas.convert>);
    case "split":
      return media.split(body as z.output<typeof schemas.split>);
    case "merge":
      return media.merge(body as z.output<typeof schemas.merge>);
  }
}
