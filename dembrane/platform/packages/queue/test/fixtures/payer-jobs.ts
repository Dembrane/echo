// Jobs of the payer tests: the fixture worker runs them and the test enqueues them.
import { z } from "zod";
import { defineJob } from "../../src";

export const paidWorkflow = defineJob("test.payer-recovered", z.object({ projectId: z.string() }), {
  retryLimit: 0,
  payer: (p) => ({ ref: "project", id: p.projectId }),
});
