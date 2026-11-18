const enc = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newWriteKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return "idl_w_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant time comparison for the admin key; hashing first hides the key length too. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((t) => crypto.subtle.digest("SHA-256", enc.encode(t))));
  return crypto.subtle.timingSafeEqual(x, y);
}
