import * as z from 'zod/v4';

export const listEnginesInput = z.object({});
export type ListEnginesInput = z.infer<typeof listEnginesInput>;

export const listEnginesOutput = z.object({
  engines: z.array(
    z.object({
      name: z.string(),
      categories: z.array(z.string()),
    }),
  ),
  categories: z.array(z.string()),
  counts: z.object({ engines: z.number(), categories: z.number() }),
  // D15 aggregation, present only when more than one instance is configured.
  instances: z
    .array(
      z.object({
        url: z.string(),
        engines: z.array(z.string()).optional(),
        unavailableEngines: z.array(z.string()).optional(),
        error: z.string().optional(),
      }),
    )
    .optional(),
  commonEngines: z.array(z.string()).optional(),
});
export type ListEnginesResponse = z.infer<typeof listEnginesOutput>;
export type ListEngineEntry = z.infer<(typeof listEnginesOutput.shape)['engines']['element']>;
