import { describe, expect, test } from "bun:test";

import { isHubMediaRequest } from "./server";

// The media boundary's selector, before the session contract owned it.
const PREVIOUS_SELECTOR = /^\/s\/[^/]+\/api\/media$/;

describe("isHubMediaRequest", () => {
  const paths = [
    "/s/uatu/api/media",
    "/s/a%2Fb/api/media",
    "/s/uatu/api/media/",
    "/s/uatu/api/media/x",
    "/s/uatu/api/mediax",
    "/s/uatu/nested/api/media",
    "/s//api/media",
    "/s/uatu",
    "/s/uatu/",
    "/api/media",
    "/media/s/uatu/api/media",
    "/s/uatu/api/state",
  ];

  test("selects exactly the paths the previous pattern selected, on any method", () => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"]) {
      for (const pathname of paths) {
        const request = new Request(`http://127.0.0.1${pathname}?path=a.mp4`, { method });
        expect({ method, pathname, media: isHubMediaRequest(request) })
          .toEqual({ method, pathname, media: PREVIOUS_SELECTOR.test(pathname) });
      }
    }
  });

  test("a session's media path is a media request", () => {
    expect(isHubMediaRequest(new Request("http://127.0.0.1/s/uatu/api/media?path=a.mp4"))).toBe(true);
    expect(isHubMediaRequest(new Request("http://127.0.0.1/s/uatu/api/media/"))).toBe(false);
    expect(isHubMediaRequest(new Request("http://127.0.0.1/api/media"))).toBe(false);
  });
});
