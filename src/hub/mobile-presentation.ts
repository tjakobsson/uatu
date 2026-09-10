// Hub documents deliberately keep their own delivery and system-color tokens.
export const HUB_MOBILE_STYLE = `
  .hub-mobile-only, .hub-mobile-nav { display: none; }
  .row-secondary > summary { display: none; }
  .row-secondary { display: contents; }
  .row-secondary-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .4rem; }
  @media (pointer: coarse) {
    body { font-size: 1rem; background: var(--surface-muted); }
    main { max-width: 52rem; padding: calc(1.25rem + var(--titlebar-inset, 0px) + env(safe-area-inset-top, 0px)) max(1rem, env(safe-area-inset-left, 0px)) calc(var(--hub-nav-height, 6rem) + 2rem); }
    .hub-header { flex-direction: row; justify-content: flex-start; gap: .6rem; margin: 0 0 2rem; }
    .hub-header .brand-logo { width: 2rem; height: 2rem; }
    .brand-wordmark { font-size: 1.15rem; overflow-wrap: anywhere; min-width: 0; }
    .hub-version { text-align: left; margin: -1rem 0 1.5rem; font-size: .8rem; overflow-wrap: anywhere; }
    .hub-nav { display: none; }
    .hub-mobile-only { display: block; }
    .hub-page-title { margin: 0 0 1.5rem; font-size: 2rem; line-height: 1.15; letter-spacing: -.025em; overflow-wrap: anywhere; }
    .hub-mobile-nav { display: flex; align-items: stretch; position: fixed; z-index: 8; bottom: max(.5rem, env(safe-area-inset-bottom, 0px)); left: max(.75rem, env(safe-area-inset-left, 0px)); right: max(.75rem, env(safe-area-inset-right, 0px)); max-width: 50rem; margin: auto; padding: .4rem; gap: .25rem; border: 1px solid var(--border-soft); border-radius: 1.75rem; background: color-mix(in srgb, var(--surface-raised) 96%, transparent); backdrop-filter: blur(12px); box-shadow: 0 .4rem 2rem #0002; max-height: 45dvh; overflow-y: auto; }
    .hub-mobile-nav > a, .hub-mobile-nav > button { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: .7rem .5rem; border: 0; border-radius: 1.25rem; color: var(--text-subtle); font-size: 1rem; background: transparent; overflow-wrap: anywhere; white-space: normal; }
    .hub-mobile-nav > [aria-current=page] { color: var(--accent); background: var(--accent-soft); }
    .pane { border: 0; border-radius: 1rem; margin-bottom: 1.5rem; }
    .pane-header { padding: .85rem 1rem; gap: .5rem; flex-wrap: wrap; }
    .pane-header h2 { font-size: 1rem; }
    .pane-meta { font-size: .8rem; white-space: normal; overflow-wrap: anywhere; }
    .row { flex-wrap: wrap; padding: 1rem; align-items: flex-start; }
    .row-main { flex-basis: calc(100% - 2rem); }
    .row-title { flex-wrap: wrap; }
    .row-title a, .row-title strong { font-size: 1.15rem; white-space: normal; overflow-wrap: anywhere; }
    .row-path { font-size: .85rem; white-space: normal; overflow-wrap: anywhere; }
    .row-detail, .credential-summary, .tool-results { font-size: .9rem; overflow-wrap: anywhere; }
    .row-actions { flex: 1 0 100%; align-items: center; justify-content: flex-end; }
    .row-primary { color: var(--accent); background: var(--accent-soft); border-color: transparent; border-radius: 2rem; }
    .row-secondary { display: block; }
    .row-secondary > summary { display: flex; align-items: center; justify-content: center; cursor: pointer; min-width: 44px; min-height: 44px; padding: .5rem; color: var(--accent); border-radius: 1rem; }
    .row-secondary[open] { flex-basis: 100%; }
    .row-secondary[open] > summary { justify-content: flex-end; }
    .row-secondary-actions { display: flex; gap: .5rem; flex-wrap: wrap; justify-content: flex-end; }
    button, input[type=text], input[type=password], input[type=file], select, textarea { font-size: 1rem; min-height: 44px; max-width: 100%; }
    button { white-space: normal; overflow-wrap: anywhere; }
    input, select { min-width: 0; }
    input[type=range] { min-height: 44px; width: 100%; }
    summary, a { touch-action: manipulation; }
    summary, .form-stack label, .inline-form label, .field-label, .assignment-add h4, .assignment-add .assignment-help, .credential-section h3, .credential-create summary, .workspace-credential-section > summary, .paste-option summary { font-size: 1rem; }
    summary { min-height: 44px; }
    .chip, .assignment-pill { font-size: .85rem; }
    .credential-head { flex-wrap: wrap; }
    .credential-head strong { flex-basis: 100%; }
    .credential-state { justify-content: flex-start; }
    .assignment-add, .workspace-assignment-form { grid-template-columns: 1fr; }
    .inline-form input:not([type=file]), .inline-form select, .inline-form > button { height: auto; min-height: 44px; }
    .assignment-pill { flex-wrap: wrap; overflow-wrap: anywhere; }
    .assignment-pill button { min-width: 44px; }
    .credential-dialog { width: min(36rem, calc(100vw - 1rem)); max-height: calc(100dvh - var(--titlebar-inset, 0px) - 2rem); overflow-y: auto; border-radius: 1.25rem; }
    .credential-dialog h2 { font-size: 1.25rem; }
    .credential-dialog-actions, .folder-dialog-actions { flex-wrap: wrap; position: sticky; bottom: -1rem; padding: .75rem 0; background: var(--surface-raised); }
    .credential-dialog-actions button, .folder-dialog-actions button { flex: 1 1 auto; }
    .empty, .local-error, .error-text, .advisory, .clone-status strong, .clone-status span:last-child, .clone-response label { font-size: 1rem; }
    .clone-output { font-size: .9rem; }
    .hub-add-action { display: block; padding: 1rem; background: var(--surface); border-radius: 1rem; margin: 1rem 0; font-size: 1.15rem; }
    .hub-add-action small { display: block; color: var(--text-subtle); font-size: .9rem; }
  }
  @media (pointer: coarse) and (prefers-reduced-transparency: reduce) {
    .hub-mobile-nav { background: var(--surface-raised); backdrop-filter: none; }
  }
`;
