/** Client-side external subtitle helpers (.srt / .vtt). */

export function srtToVtt(srt: string): string {
  const normalized = srt.replace(/\r/g, "").trim();
  if (!normalized) return "WEBVTT\n\n";

  const blocks = normalized.split(/\n\n+/);
  let vtt = "WEBVTT\n\n";

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    const timeLineIndex = lines.findIndex((line) => /-->/i.test(line));
    if (timeLineIndex < 0) continue;

    const timeLine = lines[timeLineIndex].replace(/,/g, ".");
    const text = lines.slice(timeLineIndex + 1).join("\n");
    vtt += `${timeLine}\n${text}\n\n`;
  }

  return vtt;
}

export async function subtitleFileToObjectUrl(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  const text = await file.text();

  if (lower.endsWith(".vtt")) {
    const blob = new Blob([text.startsWith("WEBVTT") ? text : `WEBVTT\n\n${text}`], {
      type: "text/vtt",
    });
    return URL.createObjectURL(blob);
  }

  if (lower.endsWith(".srt")) {
    const vtt = srtToVtt(text);
    const blob = new Blob([vtt], { type: "text/vtt" });
    return URL.createObjectURL(blob);
  }

  throw new Error("Unsupported subtitle format. Use .srt or .vtt files.");
}
