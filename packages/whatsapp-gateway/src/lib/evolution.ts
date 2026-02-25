const EVOLUTION_API_URL =
  process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "sexta-feira";
const DEFAULT_RECIPIENT = process.env.WHATSAPP_RECIPIENT || "";

export async function sendWhatsApp(
  text: string,
  recipient?: string,
): Promise<unknown> {
  const number = recipient || DEFAULT_RECIPIENT;
  if (!number) throw new Error("No recipient specified");

  const url = `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify({ number, text }),
  });

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
  try {
    return await sendWhatsApp(text, recipient);
  } catch {
    await new Promise((r) => setTimeout(r, 5000));
    return await sendWhatsApp(text, recipient);
  }
}
