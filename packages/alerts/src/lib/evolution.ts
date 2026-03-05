import got from "got";
import { env } from "./env.js";

export interface SendWhatsAppOptions {
  apiUrl?: string;
  apiKey?: string;
  instance?: string;
}

export async function sendWhatsApp(
  text: string,
  recipient?: string,
  options?: SendWhatsAppOptions,
): Promise<unknown> {
  const number = recipient || env.WHATSAPP_RECIPIENT;
  if (!number) throw new Error("No recipient specified");

  const apiUrl = options?.apiUrl || env.EVOLUTION_API_URL;
  const apiKey = options?.apiKey || env.EVOLUTION_API_KEY;
  const instance = options?.instance || env.EVOLUTION_INSTANCE;

  if (!apiKey) throw new Error("No EVOLUTION_API_KEY configured");

  return got.post(`${apiUrl}/message/sendText/${instance}`, {
    json: { number, text },
    headers: { apikey: apiKey },
    timeout: { request: 10_000 },
    retry: { limit: 0 },
  }).json();
}
