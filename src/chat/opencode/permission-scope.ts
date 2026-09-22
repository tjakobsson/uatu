/**
 * OpenCode's persistent-approval reach, verified against a live OpenCode
 * 1.18.18 and again against 2.0.13: an "always" reply carries past the
 * request into every later conversation the same OpenCode server handles,
 * grants the request's `always`/`save` pattern rather than only the resource
 * on the card, and is lost when that server restarts (on neither generation
 * does it reach the saved-permission list). The card states exactly this and
 * names OpenCode on purpose.
 */
export const OPENCODE_PERMISSION_SCOPE_NOTE = "“Allow always” also covers later conversations, and similar requests — until OpenCode restarts.";
