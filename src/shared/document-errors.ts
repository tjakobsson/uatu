// Machine tags in `/api/document` error bodies that the client compares
// against. The server sends them (src/server/routes.ts) and the preview reads
// them (src/preview/load-retry.ts); one constant on both sides means rewording
// a tag cannot silently drop the client behavior keyed on it. Free of
// server-only imports so the browser bundle can load it.

// 403 from `/api/document`: the file exists but the session cannot read it.
// The preview shows its permission notice only for a 403 carrying this tag,
// so a 403 from anything else in the path is never mislabeled.
export const DOCUMENT_NOT_READABLE_ERROR = "document not readable";
