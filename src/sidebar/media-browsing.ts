import { mediaPlayer, mediaSource } from "../media/controller";
import { documentIndex } from "../shell/document-state";
import { setFollowEnabled, syncFollowToggle } from "../shell/follow";
import type { DocumentMeta } from "../shared/types";
import { fileKey } from "./recent-model";
import { currentAuditionDocuments, renderSidebar, syncFilesPlayingIndicator } from "./shell";
import type { FilesMediaType } from "./media-browsing-model";
import "../media/browsing.css";

export let filesMediaType: FilesMediaType = "all";

export function auditionFromFiles(doc: DocumentMeta): void {
  const current = documentIndex.find(doc.id, doc.rootId);
  const source = current && mediaSource(current, documentIndex.epoch);
  if (!source) return;
  const order = currentAuditionDocuments().flatMap(entry => {
    const current = documentIndex.find(entry.id, entry.rootId);
    const source = current && mediaSource(current, documentIndex.epoch);
    return source ? [source] : [];
  });
  if (!order.some(entry => fileKey(entry) === fileKey(source))) return;
  setFollowEnabled(false);
  syncFollowToggle();
  // No await or navigation before native Play: preserve the initiating gesture.
  mediaPlayer.audition(source, order);
}

export function initMediaBrowsing(): void {
  const slot = document.querySelector<HTMLElement>("#files-type-options")!;
  const label = document.createElement("label");
  label.textContent = "File types";
  const select = document.createElement("select");
  select.id = "files-media-type";
  select.setAttribute("aria-label", "File types");
  for (const [value, text] of [["all", "All types"], ["audio", "Audio"], ["video", "Video"]]) {
    const option = document.createElement("option"); option.value = value!; option.textContent = text!; select.append(option);
  }
  label.append(select); slot.replaceChildren(label); slot.hidden = false;
  select.addEventListener("change", () => {
    filesMediaType = select.value as FilesMediaType;
    renderSidebar();
  });
  let previous: string | null = null;
  mediaPlayer.subscribe(snapshot => {
    const key = snapshot.playing && snapshot.source ? fileKey(snapshot.source) : null;
    if (key === previous) return;
    previous = key;
    syncFilesPlayingIndicator(key);
  });
}
