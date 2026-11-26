import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import {
  describeImage,
  devicePixelScale,
  enclosingLink,
  rasterEnlarged,
  imageIdentity,
  imageKind,
  isSmallMedia,
  isSvgSource,
  isMermaidIdentity,
  mermaidIdentity,
  occurrenceIdentities,
  sameAspectRatio,
  SMALL_MEDIA_PX,
} from "./media";

const BASE = "http://localhost:4711/docs/guide.md";

function dom(body: string) {
  const { document } = parseHTML(`<html><body>${body}</body></html>`);
  return document as unknown as Document;
}

describe("image identity", () => {
  test("is the resolved URL with the revision parameter removed", () => {
    expect(imageIdentity("./shot.png?revision=abc123", BASE)).toBe("http://localhost:4711/docs/shot.png");
    expect(imageIdentity("../img/a.svg", BASE)).toBe("http://localhost:4711/img/a.svg");
  });

  test("is the source itself when the source is no URL", () => {
    expect(imageIdentity("http://[bad", BASE)).toBe("http://[bad");
  });

  test("keeps every other query parameter", () => {
    expect(imageIdentity("./chart.png?w=2&revision=9&h=3", BASE)).toBe("http://localhost:4711/docs/chart.png?w=2&h=3");
  });

  test("keeps encoded # and ? that belong to the file name", () => {
    expect(imageIdentity("./screenshot%232.png?revision=1", BASE)).toBe(
      "http://localhost:4711/docs/screenshot%232.png",
    );
    expect(imageIdentity("./what%3F.png?revision=1", BASE)).toBe("http://localhost:4711/docs/what%3F.png");
  });

  test("two revisions of one file share an identity", () => {
    expect(imageIdentity("./a.png?revision=1", BASE)).toBe(imageIdentity("./a.png?revision=2", BASE));
  });
});

describe("occurrence identities", () => {
  test("media sharing a key are told apart by their order among that key's copies only", () => {
    expect(occurrenceIdentities(["a", "b", "a", "a", "b"])).toEqual(
      occurrenceIdentities(["a", "b", "a", "a", "b"]),
    );
    const [a0, b0, a1, a2, b1] = occurrenceIdentities(["a", "b", "a", "a", "b"]);
    expect(new Set([a0, b0, a1, a2, b1]).size).toBe(5);
    // Removing a copy under another key shifts nothing.
    expect(occurrenceIdentities(["a", "a", "a", "b"])).toEqual([a0, a1, a2, b0]);
  });

  test("never take a diagram's form", () => {
    for (const identity of occurrenceIdentities(["mermaid:0", "mermaid:0"])) expect(isMermaidIdentity(identity)).toBe(false);
  });
});

describe("media kind", () => {
  test("SVG is recognised by path or data URL, ignoring query and fragment", () => {
    expect(isSvgSource("./a.svg?revision=1", BASE)).toBe(true);
    expect(isSvgSource("./A.SVG", BASE)).toBe(true);
    expect(isSvgSource("data:image/svg+xml,%3Csvg%2F%3E", BASE)).toBe(true);
    expect(isSvgSource("./a.png", BASE)).toBe(false);
    expect(isSvgSource("./a.svg.png", BASE)).toBe(false);
  });

  test("an encoded file name is read decoded, as the server reads it; a malformed encoding is read as written", () => {
    expect(isSvgSource("./figure%2Esvg?revision=1", BASE)).toBe(true);
    expect(isSvgSource("./figure%2esvg", BASE)).toBe(true);
    expect(isSvgSource("./figure%2Epng", BASE)).toBe(false);
    expect(isSvgSource("./bad%E0%A4%A.svg", BASE)).toBe(true);
    expect(isSvgSource("./bad%E0%A4%A.png", BASE)).toBe(false);
  });
});

describe("image kind", () => {
  test("an encoded extension is read decoded", () => {
    expect(imageKind("./figure%2Esvg?revision=1", BASE)).toBe("svg-image");
    expect(imageKind("https://cdn.example.com/shot%2Epng", BASE)).toBe("raster");
    expect(imageKind("https://cdn.example.com/bad%E0%A4%A", BASE)).toBe("svg-image");
  });

  test("SVG sources are vector, wherever they come from", () => {
    expect(imageKind("./a.svg?revision=1", BASE)).toBe("svg-image");
    expect(imageKind("data:image/svg+xml,%3Csvg%2F%3E", BASE)).toBe("svg-image");
    expect(imageKind("https://example.com/logo.svg", BASE)).toBe("svg-image");
  });

  test("workspace images keep extension-based classification: anything not SVG is raster", () => {
    expect(imageKind("./a.png?revision=2", BASE)).toBe("raster");
    expect(imageKind("./shot", BASE)).toBe("raster");
    expect(imageKind("/docs/photo.JPEG", BASE)).toBe("raster");
  });

  test("raster data: URLs and cross-origin raster extensions are raster", () => {
    expect(imageKind("data:image/png;base64,iVBORw0KGgo=", BASE)).toBe("raster");
    expect(imageKind("data:image/jpeg;base64,/9j/", BASE)).toBe("raster");
    for (const name of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.avif", "a.bmp", "a.ico", "a.apng"]) {
      expect(imageKind(`https://cdn.example.com/img/${name}?v=1`, BASE)).toBe("raster");
    }
  });

  test("a cross-origin image of unknown format is treated as vector", () => {
    // shields.io badges are SVG; GitHub attachments are usually PNG. Neither
    // URL says which, and a cross-origin response's type is not readable.
    expect(imageKind("https://img.shields.io/badge/build-passing-green", BASE)).toBe("svg-image");
    expect(imageKind("https://github.com/user-attachments/assets/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", BASE)).toBe("svg-image");
    expect(imageKind("https://example.com/image.php?id=3", BASE)).toBe("svg-image");
  });
});

describe("small media", () => {
  test("either side below 96 CSS px is small; 96 is not", () => {
    expect(SMALL_MEDIA_PX).toBe(96);
    expect(isSmallMedia({ width: 95, height: 400 })).toBe(true);
    expect(isSmallMedia({ width: 400, height: 95 })).toBe(true);
    expect(isSmallMedia({ width: 96, height: 96 })).toBe(false);
    expect(isSmallMedia({ width: 95.9, height: 200 })).toBe(true);
    expect(isSmallMedia({ width: 80, height: 20 })).toBe(true);
  });
});

describe("enclosing link", () => {
  test("finds the link around an image, or none", () => {
    const document = dom('<p><a id="l" href="other.md"><img id="linked" src="a.png"></a> <img id="plain" src="b.png"></p>');
    expect(enclosingLink(document.getElementById("linked") as HTMLImageElement)?.id).toBe("l");
    expect(enclosingLink(document.getElementById("plain") as HTMLImageElement)).toBeNull();
  });

  test("an anchor without href is not a link", () => {
    const document = dom('<a id="n" name="x"><img id="i" src="a.png"></a>');
    expect(enclosingLink(document.getElementById("i") as HTMLImageElement)).toBeNull();
  });
});

describe("descriptors", () => {
  test("an image descriptor carries kind, real source, identity, link and aspect ratio", () => {
    const document = dom('<a id="l" href="x.md"><img id="i" src="data:image/svg+xml,placeholder"></a>');
    const image = document.getElementById("i") as HTMLImageElement;
    const descriptor = describeImage(image, "./figure.svg?revision=4", BASE, { width: 400, height: 200 });
    expect(descriptor).toEqual({
      kind: "svg-image",
      source: "http://localhost:4711/docs/figure.svg?revision=4",
      identity: "http://localhost:4711/docs/figure.svg",
      link: document.getElementById("l") as HTMLAnchorElement,
      aspectRatio: 2,
    });
  });

  test("a cross-origin image of unknown format gets vector treatment", () => {
    const document = dom('<img id="i" src="https://img.shields.io/badge/ci-passing-green">');
    const descriptor = describeImage(document.getElementById("i") as HTMLImageElement, "https://img.shields.io/badge/ci-passing-green", BASE, { width: 90, height: 20 });
    expect(descriptor.kind).toBe("svg-image");
  });

  test("a raster image without a known size has no aspect ratio", () => {
    const document = dom('<img id="i" src="a.png">');
    const descriptor = describeImage(document.getElementById("i") as HTMLImageElement, "./a.png", BASE, { width: 0, height: 0 });
    expect(descriptor.kind).toBe("raster");
    expect(descriptor.link).toBeNull();
    expect(descriptor.aspectRatio).toBeNull();
  });

  test("Mermaid diagrams are identified by their position among the document's diagrams", () => {
    const document = dom(
      '<div id="root"><div class="mermaid" id="a"></div><p>text</p><div class="mermaid" id="b"></div><div><div class="mermaid" id="c"></div></div></div>',
    );
    const root = document.getElementById("root")!;
    expect(mermaidIdentity(document.getElementById("a")!, root)).toBe("mermaid:0");
    expect(mermaidIdentity(document.getElementById("b")!, root)).toBe("mermaid:1");
    expect(mermaidIdentity(document.getElementById("c")!, root)).toBe("mermaid:2");
  });
});

describe("aspect ratio matching", () => {
  test("holds within 1% and fails beyond it", () => {
    expect(sameAspectRatio({ width: 400, height: 300 }, { width: 800, height: 600 })).toBe(true);
    expect(sameAspectRatio({ width: 400, height: 300 }, { width: 400, height: 302 })).toBe(true);
    expect(sameAspectRatio({ width: 400, height: 300 }, { width: 400, height: 304 })).toBe(false);
    expect(sameAspectRatio({ width: 400, height: 300 }, { width: 300, height: 400 })).toBe(false);
  });

  test("an empty box matches nothing", () => {
    expect(sameAspectRatio({ width: 0, height: 0 }, { width: 0, height: 0 })).toBe(false);
    expect(sameAspectRatio({ width: 400, height: 0 }, { width: 400, height: 300 })).toBe(false);
  });

  test("diagram identities are told apart from image identities", () => {
    expect(isMermaidIdentity("mermaid:3")).toBe(true);
    expect(isMermaidIdentity(imageIdentity("./mermaid.png", BASE))).toBe(false);
  });
});

describe("device pixel scale", () => {
  test("multiplies the device pixel ratio by the page's pinch zoom", () => {
    expect(devicePixelScale({ devicePixelRatio: 2, visualViewport: { scale: 1.5 } })).toBe(3);
    expect(devicePixelScale({ devicePixelRatio: 2, visualViewport: null })).toBe(2);
  });

  test("treats a missing or unusable value as 1", () => {
    expect(devicePixelScale(undefined)).toBe(1);
    expect(devicePixelScale({ devicePixelRatio: 0, visualViewport: { scale: Number.NaN } })).toBe(1);
  });
});

describe("raster enlargement", () => {
  test("counts device pixels, at fit as when zoomed", () => {
    // A 200px image shown 200 CSS px wide on a 2× screen covers 400 device px.
    expect(rasterEnlarged(200, 200, 2)).toBe(true);
    expect(rasterEnlarged(200, 200, 1)).toBe(false);
    expect(rasterEnlarged(400, 200, 2)).toBe(false);
    // Exactly native size (actual pixels), give or take rounding, is not enlarged.
    expect(rasterEnlarged(3000, 3000 / 3 + 1e-9, 3)).toBe(false);
    // An image with no known size never is.
    expect(rasterEnlarged(0, 200, 2)).toBe(false);
  });
});
