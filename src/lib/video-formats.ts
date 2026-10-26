import path from "path";

export const VIDEO_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".avi",
  ".xvid",
  ".mov",
  ".wmv",
  ".m4v",
  ".webm",
  ".ts",
  ".m2ts",
]);

const LEGACY_VIDEO_EXTENSIONS = new Set([".avi", ".xvid", ".wmv"]);

export function isVideoExtension(filename: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function isLegacyVideoExtension(filePath: string): boolean {
  return LEGACY_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function videoMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".xvid": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".wmv": "video/x-ms-wmv",
    ".m4v": "video/x-m4v",
    ".webm": "video/webm",
    ".ts": "video/mp2t",
  };
  return mimeMap[ext] ?? "application/octet-stream";
}
