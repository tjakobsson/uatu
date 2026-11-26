import type { DocumentMeta } from "../shared/types";
import { mediaUrl } from "../shared/media";
import { mediaPlayer, mediaSource } from "./controller";
import { clearPreviewType, previewPathElement, previewTitleElement, setPreviewBase } from "../preview/header";
import { hideViewToggle } from "../preview/view-mode";
import { mountLayoutToolbar } from "../preview/layout";
import { refreshOutline } from "../preview/outline";
import { documentIndex } from "../shell/document-state";
import "./preview.css";

let unsubscribe: (() => void) | null = null;
// What Play does before the audition starts (app.ts: turn Follow off). It is
// injected because importing shell/follow here would put the shell, sidebar
// and shell/events underneath preview/mount.ts, which imports this module.
// Bun's dev runtime hands a module still evaluating up such a cycle to its
// importers as null, so module-scope reads of it crash the dev bundle
// (tests/e2e/dev-bundle.e2e.ts).
let beforeAudition: () => void = () => {};
export function setBeforeMediaPreviewAudition(run: () => void): void {
  beforeAudition = run;
}
export function releaseMediaPreview(): void {
  if (!unsubscribe) return;
  unsubscribe(); unsubscribe = null;
  mediaPlayer.attachDefaultElement();
}
export function renderMediaPreview(doc: DocumentMeta, epoch: string | null): void {
  releaseMediaPreview();
  const preview = document.querySelector<HTMLElement>("#preview")!;
  previewTitleElement.textContent = doc.name;
  previewPathElement.textContent = doc.relativePath;
  setPreviewBase(doc.relativePath); clearPreviewType(); hideViewToggle(); mountLayoutToolbar(false); refreshOutline(null);
  preview.classList.remove("empty", "is-split", "is-split-h", "is-split-v");
  const card = document.createElement("section"); card.className = "media-preview";
  const title = document.createElement("h2"); title.textContent = doc.name;
  const path = document.createElement("p"); path.textContent = `${doc.rootId} / ${doc.relativePath}`;
  const host = document.createElement("div"); host.className = "media-preview-element";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const play = document.createElement("button"); play.type = "button"; play.textContent = "Play";
  const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Retry";
  const download = document.createElement("a"); download.textContent = "Download"; download.download = doc.name;
  card.append(title, path, host, status, play, retry, download); preview.replaceChildren(card);
  const source = mediaSource(doc, epoch);
  if (!source) { status.textContent = "Media identity unavailable. Wait for discovery or select the file again."; play.disabled = true; retry.hidden = true; download.hidden = true; return; }
  const latestSource = () => {
    const current = documentIndex.find(doc.id, doc.rootId);
    return current ? mediaSource(current, documentIndex.epoch) : null;
  };
  play.onclick = () => {
    const latest = latestSource();
    if (!latest) return;
    beforeAudition(); mediaPlayer.audition(latest, [latest]);
  };
  retry.onclick = () => {
    const current = mediaPlayer.snapshot().source;
    if (current?.id === source.id && current.rootId === source.rootId) mediaPlayer.reload();
    else mediaPlayer.present(source);
  };
  // Preparation belongs to navigation. A subscriber must never undo Close.
  mediaPlayer.present(source);
  let mountedElement: HTMLMediaElement | null = null;
  unsubscribe = mediaPlayer.subscribe(state => {
    const latest = latestSource();
    const same = state.source?.id === source.id && state.source.rootId === source.rootId;
    if (same && state.element && mountedElement !== state.element) {
      mountedElement = state.element;
      mediaPlayer.attachElement(host);
    }
    status.textContent = !latest ? "File unavailable. It may have been removed or excluded." : same ? state.error ?? (state.unavailable ? "File unavailable." : state.newRenderAvailable ? "New render available. Reload in the player." : state.loading ? "Loading media metadata..." : state.playing ? "Playing" : "Paused") : "Press Play to audition this file.";
    play.hidden = same && state.playing;
    play.disabled = !latest || same && (state.newRenderAvailable || state.unavailable);
    retry.hidden = !same || !state.error || state.unavailable;
    // Inventory changes update links even after Close or while another clip
    // plays. Updating an anchor must never prepare or fetch a media source.
    if (latest) download.href = mediaUrl(latest, latest.epoch);
    else download.removeAttribute("href");
    download.hidden = !latest;
  });
}
