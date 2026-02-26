import got from "got";
import { env } from "./env.js";

export async function sendWhatsApp(
  text: string,
  recipient?: string,
): Promise<unknown> {
  const number = recipient || env.WHATSAPP_RECIPIENT;
  if (!number) throw new Error("No recipient specified");

  return got.post(`${env.EVOLUTION_API_URL}/message/sendText/${env.EVOLUTION_INSTANCE}`, {
    json: { number, text },
    headers: { apikey: env.EVOLUTION_API_KEY },
    timeout: { request: 10_000 },
    retry: { limit: 0 },
  }).json();
}

export async function sendWithRetry(
  text: string,
  recipient?: string,
): Promise<unknown> {
  const number = recipient || env.WHATSAPP_RECIPIENT;
  if (!number) throw new Error("No recipient specified");

  return got.post(`${env.EVOLUTION_API_URL}/message/sendText/${env.EVOLUTION_INSTANCE}`, {
    json: { number, text },
    headers: { apikey: env.EVOLUTION_API_KEY },
    timeout: { request: 10_000 },
    retry: { limit: 1, backoffLimit: 5000 },
  }).json();
}
