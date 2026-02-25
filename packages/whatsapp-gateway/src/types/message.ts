import { z } from "zod";

export const SendMessageSchema = z.object({
  text: z.string().min(1),
  recipient: z.string().optional(),
});

export type SendMessage = z.infer<typeof SendMessageSchema>;
