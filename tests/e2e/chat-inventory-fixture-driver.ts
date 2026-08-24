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

const attribute = "data-e2e-chat-inventory-fixture";
const encoded = document.documentElement.getAttribute(attribute);
document.documentElement.removeAttribute(attribute);

if (encoded) {
  const state = JSON.parse(encoded) as FixtureState;
  renderConversationInventoryAwareness(document, state.unseenCount);
  if (state.announce) announceConversationInventory(document, state.unseenCount);
  renderSelectedConversationDeleted(document, state.selectedConversationDeleted === true);
}
