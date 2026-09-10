## Why

The implemented touch Hub does not reproduce the approved refined reference: desktop-oriented panels and inline forms replaced its mobile hierarchy, grouped Settings, icon navigation, and task sheets. Functional checks passed without enforcing visual fidelity, and full-page navigation prevents the workspace continuity the user now explicitly requires.

## What Changes

- Deliver the **actual reusable frontend first**, against a test-only mocked backend, for hands-on visual and interaction approval before any real backend integration. This change's implementation tasks stop at that review gate.
- Treat `design/hub-mobile/refined.html` and its retained screenshots as a screen/state-level visual contract, not loose inspiration. Retain the current UatuCode name/logo as an explicit exception; keep system accessibility adaptations. Desktop Hub presentation and workspace interiors are not redesigned.
- Implement reference-faithful touch dashboard composition, grouped Settings and detail views, task sheets, icon-and-label navigation, Return hierarchy, and coordinated overlay materials. Extend that language to unpictured production states and present those extensions for review.
- Preserve one active workspace's browser-side state and ongoing client work across ordinary Hub/Settings/Return navigation through a **same-document integration with no iframes**. This supersedes the archived change's restoration-only constraint, not authentication or server-session lifetime rules.
- Model truthful branch/detached/unborn/non-Git/unavailable metadata in the frontend interface and synthetic review fixtures. Real Git probing and any public API additions are deferred until frontend approval.
- Add a deterministic review harness, visual comparisons, continuity tests, and an explicit human acceptance record. Keep mocks, fictional identities, scenario controls, and simulated operations in `tests/`, never in product code.

## Capabilities

### New Capabilities

- `mobile-hub-continuity`: Same-document, frame-free workspace retention across touch Hub and Settings visits, including route ownership, focus isolation, async work, and invalidation.
- `mobile-hub-review`: Isolated mocked-backend review of the shipping frontend, deterministic scenarios, evidence, and a mandatory approval gate before live integration.

### Modified Capabilities

- `hub-dashboard`: Replace approximate touch presentation with a reference-fidelity contract and coherent overview/detail/task composition while retaining complete operations, current branding, and desktop behavior.
- `touch-navigation`: Replace the full-page Hub-detour requirement with same-document mobile workspace retention while preserving server-owned lifetimes and the existing desktop, standalone, and cross-workspace boundaries.

## Impact

- Frontend work is expected under `src/hub/` with bounded integration through existing `src/shell/` and workspace entry owners. The existing workspace surfaces, `appState`, document identity, credential operations, and terminal/chat behavior remain owned by their current modules.
- Test-only launchers, backend doubles, and fixtures live under `tests/`; colocated unit tests and feature E2E tests remain at the existing seams. Review serves a distinct loopback port and Tailscale endpoint without replacing the existing Hub or the archived reference endpoint.
- No new runtime dependencies, live credential provisioning, real clone/start/stop operations, production Git probes, published API changes, or native Desktop changes are authorized in the frontend-first stage. Any required dependency or material architectural expansion must be raised before proceeding.
- The later integration stage must connect the same frontend to real operations, publish the branch metadata contract, verify security/lifecycle behavior, and preserve the visually approved result. A mock pass is not evidence of live operation correctness.
- Supporting artifacts: `diagnosis.md`, `reference-contract.md`, and `screen-map.md`. The archived change and original reference remain historical evidence and are not rewritten.
