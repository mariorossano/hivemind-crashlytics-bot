/** Bound protocol input in bytes and decode UTF-8 only after reassembling chunks.
 * Parse failures must never echo connection credentials from stdin.
 */
export async function readJsonInput(
  stream: AsyncIterable<Uint8Array | string>,
  limit = 65536,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error('JSON input exceeded the byte limit');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error('Invalid JSON input');
  }
}
