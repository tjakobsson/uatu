import type { StatePayload, RepositorySnapshot } from "../../src/shared/types";
import type { ConversationSnapshot, AssistantMessageItem } from "../../src/chat/types";

export const continuityCommit = "1234567890abcdef1234567890abcdef12345678";
export function continuityCorpus(base: StatePayload): StatePayload {
  const state = structuredClone(base);
  const root = state.roots[0]!;
  root.docs.push(...Array.from({ length: 100 }, (_, i) => ({ ...root.docs[0]!, id: `continuity-${i}`, name: `note-${String(i).padStart(3, "0")}.md`, relativePath: `note-${String(i).padStart(3, "0")}.md` })));
  const identity = { id: "continuity-repo", rootPath: root.path, label: "Synthetic continuity repository", watchedRootIds: [root.id] };
  const repository: RepositorySnapshot = {
    ...identity, metadata: { ...identity, status: "git", branch: "synthetic", detached: false, commitShort: continuityCommit.slice(0, 7), dirty: false, message: null },
    status: "available", base: { mode: "fallback", ref: "HEAD", mergeBase: continuityCommit, compareTarget: "base", comparedAgainstRef: "HEAD", targetsCollapsed: true },
    changedFiles: [], gitIgnoredFiles: [], configWarnings: [], message: null,
    commitLog: [{ sha: continuityCommit, subject: "Synthetic populated commit", message: "Synthetic populated commit\n\nRetain the canonical commit destination through Hub navigation.", author: "Synthetic reviewer", relativeTime: "fixture time" }],
  };
  state.repositories = [repository];
  return state;
}
export const continuityDocument = '<h1 id="synthetic-review-document">Synthetic review document</h1><p>No live workspace was read.</p>' + Array.from({ length: 80 }, (_, i) => `<section><h2 id="continuity-section-${i}">Continuity section ${i}</h2><p>Long synthetic document content for real viewport scrolling. This text never comes from a host workspace.</p></section>`).join("");
export function continuityConversation(base: ConversationSnapshot): ConversationSnapshot {
  return { ...structuredClone(base), items: Array.from({ length: 40 }, (_, i): AssistantMessageItem => ({ id: `continuity-message-${i}`, type: "assistant_message", createdAt: base.conversation.createdAt, markdown: `### Synthetic message ${i}\n\nLong retained conversation content. No provider was invoked.\n\nThis is a real Chat timeline rendered from protocol data.` })) };
}
