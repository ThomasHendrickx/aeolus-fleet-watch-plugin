/** The REST refusal body used by the fleet door and wake stream. */
import { z } from 'zod';

export const refusalSchema = z.object({ code: z.string(), message: z.string() });
