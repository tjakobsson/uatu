import { mountMobileCoordinator } from "../../src/hub/mobile/coordinator";
import { createReviewTransport } from "./transport";
import "../../src/hub/mobile/styles.css";
import "../../src/hub/mobile/coordinator.css";
import { Terminal } from "@xterm/xterm";

declare global {
  interface Window {
    __mobileHubReview?: { state: import("../../src/shell/state").AppState; bootCount: number; terminals: Terminal[] };
    /** Test-only cold import barrier; absent in ordinary review browsing. */
    __mobileHubBootGate?: Promise<void>;
    __mobileHubBootAttempts?: number;
    __mobileHubCoordinator?: ReturnType<typeof mountMobileCoordinator>;
  }
}

// Observe the actual xterm instances for test assertions through their public
// buffer/scroll APIs. Never replace terminal creation, rendering or transport.
const terminals: Terminal[] = [];
const workspaceId = document.querySelector<HTMLMetaElement>('meta[name="uatu-review-workspace"]')!.content;
const basePath = document.querySelector<HTMLMetaElement>('meta[name="uatu-base-path"]')!.content;
const openTerminal = Terminal.prototype.open;
Terminal.prototype.open = function (...args) { terminals.push(this); return openTerminal.apply(this, args); };

// The build replaces only the real HTML's app entry. No copied workspace HTML.
// Base meta is injected before the existing pre-paint stamp and module imports.
const workspaceRoot = document.createElement("div");
workspaceRoot.id = "mobile-workspace-root";
workspaceRoot.style.cssText = "width:100%";
for (const node of [...document.body.childNodes]) {
  if (!(node instanceof HTMLScriptElement)) workspaceRoot.append(node);
}
document.body.append(workspaceRoot);
const hubRoot = document.createElement("div");
hubRoot.id = "mobile-hub-root";
hubRoot.style.cssText = "position:fixed;inset:0;z-index:1000";
document.body.append(hubRoot);
let reveal = () => {};
const eligible = () => document.documentElement.dataset.uiMode === "touch";
if (!eligible()) {
  hubRoot.remove();
  // This isolated runtime does not reimplement or inject the live desktop Hub
  // document controller. Its fine-pointer fallback is the unchanged workspace.
  if (!location.pathname.startsWith(basePath)) location.replace(basePath);
  else await import("../../src/app");
} else {
  window.__mobileHubCoordinator = mountMobileCoordinator({ hubRoot, workspaceRoot, backend: createReviewTransport(), workspaceId, basePath, eligible,
    async bootWorkspace() {
      window.__mobileHubBootAttempts = (window.__mobileHubBootAttempts ?? 0) + 1;
      await window.__mobileHubBootGate;
      const app = await import("../../src/app");
      const { appState } = await import("../../src/shell/state");
      window.__mobileHubReview = { state: appState, bootCount: (window.__mobileHubReview?.bootCount ?? 0) + 1, terminals };
      const tabs = await import("../../src/shell/tab-bar");
      reveal = tabs.revealWorkspaceNavigation;
      const mode = await import("../../src/shell/ui-mode");
       mode.onUiModeChange(next => { if (next === "desktop") location.assign(basePath); });
      await app.workspaceReady;
    },
    revealNavigation: () => reveal(),
  });
}
