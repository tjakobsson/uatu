import {
  announceConversationInventory,
  renderConversationInventoryAwareness,
  renderSelectedConversationDeleted,
} from "../../src/chat/inventory-presentation";

type FixtureState = {
  unseenCount: number;
  announce?: boolean;
  selectedConversationDeleted?: boolean;
};

// Install once per document so every update shares the same inert ownership.
Reflect.set(globalThis, "__uatuInventoryFixture", (state: FixtureState) => {
  renderConversationInventoryAwareness(document, state.unseenCount);
  if (state.announce) announceConversationInventory(document, state.unseenCount);
  renderSelectedConversationDeleted(document, state.selectedConversationDeleted === true);
});
