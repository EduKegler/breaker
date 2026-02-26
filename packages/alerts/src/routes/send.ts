import { Router, type Router as RouterType } from "express";
import { sendWhatsApp } from "../lib/evolution.js";
import { SendMessageSchema } from "../types/message.js";
import { formatZodErrors } from "@breaker/kit";

export const sendRouter: RouterType = Router();

sendRouter.post("/", async (req, res) => {
  const result = SendMessageSchema.safeParse(req.body);
  if (!result.success) {
    const errors = formatZodErrors(result.error);
    res.status(400).json({ error: "validation failed", details: errors });
    return;
  }

  try {
    await sendWhatsApp(result.data.text, result.data.recipient);
    res.json({ status: "sent" });
  } catch (err) {
    res.status(502).json({
      status: "send_failed",
      error: (err as Error).message,
    });
  }
});
