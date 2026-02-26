import pRetry from "p-retry";
import pTimeout from "p-timeout";
import { env } from "./env.js";

export async function sendWhatsApp(
  text: string,
  recipient?: string,
): Promise<unknown> {
  const number = recipient || env.WHATSAPP_RECIPIENT;
  if (!number) throw new Error("No recipient specified");

  const url = `${env.EVOLUTION_API_URL}/message/sendText/${env.EVOLUTION_INSTANCE}`;
  const res = await pTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.EVOLUTION_API_KEY,
      },
      body: JSON.stringify({ number, text }),
    }),
    { milliseconds: 10_000 },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Evolution API ${res.status}: ${errText}`);
  }

  return await res.json();
}

export async function sendWithRetry(
  text: string,
  recipient?: string,
): Promise<unknown> {
  return pRetry(() => sendWhatsApp(text, recipient), {
    retries: 1,
    minTimeout: 5000,
    factor: 1,
  });
}
