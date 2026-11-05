import { appUrl } from "./app-url";
import type { RevisionedDocument } from "./document-updates";

const formats: Record<string, readonly ["audio" | "video", string]> = {
  mp3: ["audio", "audio/mpeg"], wav: ["audio", "audio/wav"],
  ogg: ["audio", "audio/ogg"], oga: ["audio", "audio/ogg"], flac: ["audio", "audio/flac"],
  aac: ["audio", "audio/aac"], m4a: ["audio", "audio/mp4"], opus: ["audio", "audio/ogg"],
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], webm: ["video", "video/webm"],
  mov: ["video", "video/quicktime"], ogv: ["video", "video/ogg"], avi: ["video", "video/x-msvideo"],
  mkv: ["video", "video/x-matroska"], flv: ["video", "video/x-flv"],
};

function format(name: string) {
  const basename = name.split(/[\\/]/).at(-1)!;
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? formats[basename.slice(dot + 1).toLowerCase()] : undefined;
}

export function mediaKind(name: string): "audio" | "video" | null { return format(name)?.[0] ?? null; }
export function mediaMimeType(name: string): string | null { return format(name)?.[1] ?? null; }

export function mediaUrl(doc: Pick<RevisionedDocument, "rootId" | "relativePath" | "revision">, epoch: string): string {
  const query = new URLSearchParams({ rootId: doc.rootId, path: doc.relativePath, epoch, revision: String(doc.revision) });
  return appUrl(`/api/media?${query}`);
}
