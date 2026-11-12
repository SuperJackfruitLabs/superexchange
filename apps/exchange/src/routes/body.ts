/** Reading a request body with a ceiling, so one request cannot hold the process's memory. */

/** The body's bytes, or null when it is larger than `max`. */
export async function readBody(
  request: Request,
  max: number,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.length > max ? null : bytes;
}

export const tooLarge = () =>
  Response.json({ error: "body too large" }, { status: 413 });
