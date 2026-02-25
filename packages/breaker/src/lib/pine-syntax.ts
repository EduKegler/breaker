const PINE_FACADE_URL =
  "https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=admin&v=3";

export interface PineSyntaxResult {
  success: boolean;
  error?: string;
  errors?: Array<{ line: number; message: string }>;
}

export async function checkPineSyntax(
  code: string,
): Promise<PineSyntaxResult> {
  const form = new FormData();
  form.append("source", code);

  const res = await fetch(PINE_FACADE_URL, {
    method: "POST",
    body: form,
    headers: { Referer: "https://www.tradingview.com/" },
  });

  if (!res.ok) {
    throw new Error(`Pine syntax check failed: HTTP ${res.status}`);
  }

  return res.json() as Promise<PineSyntaxResult>;
}
