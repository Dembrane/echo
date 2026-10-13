// The jobs of the dead-worker tests: the worker fixture runs them and the test enqueues them.
import { z } from "zod";
import { defineJob } from "../../src";

const run = z.object({ id: z.string() });

/** Set aside at the third worker it loses. */
export const impatient = defineJob("test.impatient", run, { retryLimit: 0, lostWorkerLimit: 2 });
export const ordinary = defineJob("test.ordinary", run, { retryLimit: 0 });
