export async function readJsonResponse<T = Record<string, unknown>>(
  res: Response
): Promise<T> {
  const text = await res.text();
  if (!text) {
    throw new Error(`Empty response from server (${res.status})`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    const lower = text.trimStart().toLowerCase();
    if (lower.startsWith("<!doctype") || lower.startsWith("<html")) {
      throw new Error(
        `Server error (${res.status}). The stream may be unavailable, uncached on Real-Debrid, or the request URL was too long. Try a cached 1080p source.`
      );
    }
    throw new Error(`Invalid server response (${res.status})`);
  }
}
