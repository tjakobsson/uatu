import { describe, expect, test } from "bun:test";

import { chatMediaSource } from "./media-viewer";

const PAGE = "https://uatu.example:4702/w/docs/?t=token";

describe("chat media source guard", () => {
  test("accepts the shapes chat writes: a staged blob: preview and same-origin serve routes", () => {
    expect(chatMediaSource("blob:https://uatu.example:4702/0b5e", PAGE)).toBe("blob:https://uatu.example:4702/0b5e");
    expect(chatMediaSource("/w/docs/api/chat/attachments/abc", PAGE)).toBe("https://uatu.example:4702/w/docs/api/chat/attachments/abc");
    expect(chatMediaSource("api/chat/visuals/abc", PAGE)).toBe("https://uatu.example:4702/w/docs/api/chat/visuals/abc");
    expect(chatMediaSource("https://uatu.example:4702/api/chat/visuals/abc", PAGE)).toBe("https://uatu.example:4702/api/chat/visuals/abc");
  });

  test("rejects a cross-origin URL", () => {
    expect(chatMediaSource("https://elsewhere.example/shot.png", PAGE)).toBeNull();
    expect(chatMediaSource("//elsewhere.example/shot.png", PAGE)).toBeNull();
    expect(chatMediaSource("https://uatu.example:4703/api/chat/visuals/abc", PAGE)).toBeNull();
    expect(chatMediaSource("http://uatu.example:4702/api/chat/visuals/abc", PAGE)).toBeNull();
  });

  test("rejects other schemes and unparseable input", () => {
    expect(chatMediaSource("javascript:alert(1)", PAGE)).toBeNull();
    expect(chatMediaSource("data:image/svg+xml,<svg/>", PAGE)).toBeNull();
    expect(chatMediaSource("http://[", PAGE)).toBeNull();
  });
});
