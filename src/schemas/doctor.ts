import * as z from 'zod/v4';

export const doctorInput = z.object({});
export type DoctorInput = z.infer<typeof doctorInput>;

export const doctorOutput = z.object({
  healthy: z.boolean(),
  checks: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      detail: z.string(),
    }),
  ),
});
export type DoctorResponse = z.infer<typeof doctorOutput>;
