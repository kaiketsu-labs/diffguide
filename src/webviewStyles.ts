import { designTokenStyles } from './designTokens.js';

/**
 * Tokens plus the controls every webview shares: page text, buttons, inputs, key caps and the focus ring.
 * Give a button `data-tip` for a hover tip; icon-only buttons need one.
 * Buttons are secondary by default; add `primary` (yours, in the theme's text color), `claude` (sends to Claude, clay) or `quiet` (text only).
 */
export const webviewStyles = `${designTokenStyles}
body{color:var(--ink);background:var(--surface);font:13px/20px var(--font-ui)}
.muted{color:var(--ink-muted)}
a{color:var(--vscode-textLink-foreground,var(--brand));cursor:pointer;text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-6);box-sizing:border-box;min-height:28px;padding:0 var(--space-12);border:1px solid var(--vscode-button-border,transparent);border-radius:var(--radius-sm);color:var(--on-action-secondary);background:var(--action-secondary);font:inherit;cursor:pointer}
button:hover{filter:brightness(1.08)}
button.primary{color:var(--on-action);background:var(--action);font-weight:600}
button.claude{color:var(--on-claude);background:var(--claude);font-weight:600}
button.quiet{padding:0 var(--space-4);color:var(--ink-muted);background:none;border-color:transparent}
button.quiet:hover{color:var(--ink);filter:none;text-decoration:underline}
button.small{min-height:22px;padding:0 var(--space-8);font-size:12px}
button:disabled{opacity:.5;cursor:default;filter:none}
.icon-button{display:inline-grid;place-items:center;width:26px;min-height:26px;height:26px;padding:0;border:0;color:var(--ink-muted);background:none}
.icon-button:hover{color:var(--ink);filter:none;background:color-mix(in srgb,var(--ink) 10%,transparent)}
.icon-button svg,button svg{width:16px;height:16px;fill:currentColor;flex-shrink:0}
select{box-sizing:border-box;min-height:28px;padding:0 var(--space-8);border:1px solid var(--vscode-dropdown-border,var(--line-strong));border-radius:var(--radius-sm);color:var(--vscode-dropdown-foreground,var(--ink));background:var(--vscode-dropdown-background,var(--surface));font:inherit}
textarea,input[type=text]{box-sizing:border-box;padding:var(--space-8);border:1px solid var(--line-strong);border-radius:var(--radius-sm);color:var(--vscode-input-foreground,var(--ink));background:var(--vscode-input-background,var(--surface));font:inherit}
textarea{resize:none;field-sizing:content;max-height:240px}
textarea::placeholder{color:var(--vscode-input-placeholderForeground,var(--ink-muted))}
textarea:focus{outline:2px solid var(--focus);outline-offset:-1px}
kbd{display:inline-flex;align-items:center;height:18px;box-sizing:border-box;padding:0 var(--space-4);border:1px solid var(--line-strong);border-bottom-width:2px;border-radius:var(--radius-sm);font:11px var(--font-code);color:var(--ink-muted);background:none}
kbd.on-fill{height:16px;border-color:currentColor;color:inherit;opacity:.7}
.hint{display:inline-flex;align-items:center;gap:var(--space-2);font-size:11px;color:var(--ink-muted)}
.chip{display:inline-flex;align-items:center;gap:var(--space-6);height:20px;padding:0 var(--space-8);border-radius:var(--radius-pill);font-size:12px;line-height:18px;color:var(--ink-muted);background:color-mix(in srgb,var(--ink) 8%,transparent)}
.chip::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
.chip.claude{color:var(--claude);background:var(--claude-soft)}
.chip.working::before{animation:pulse 1.2s ease-in-out infinite}
.chip.warning{color:var(--warning);background:color-mix(in srgb,var(--warning) 14%,transparent)}
.chip.pending{color:var(--pending);background:var(--pending-soft)}
.chip.success{color:var(--success);background:color-mix(in srgb,var(--success) 14%,transparent)}
.chip.danger{color:var(--danger);background:var(--danger-soft)}
[data-tip]{position:relative}
[data-tip]:hover::after,[data-tip]:focus-visible::after{content:attr(data-tip);position:absolute;top:calc(100% + var(--space-6));right:0;z-index:30;padding:var(--space-2) var(--space-8);border:1px solid var(--vscode-editorHoverWidget-border,var(--line));border-radius:var(--radius-sm);color:var(--vscode-editorHoverWidget-foreground,var(--ink));background:var(--vscode-editorHoverWidget-background,var(--surface-raised));box-shadow:var(--shadow-overlay);font:400 12px/18px var(--font-ui);white-space:nowrap;pointer-events:none;animation:tip-in .1s .25s both}
@keyframes tip-in{from{opacity:0}}
@keyframes pulse{50%{opacity:.3;transform:scale(.7)}}
@media (prefers-reduced-motion:reduce){.chip.working::before{animation:none}}`;
