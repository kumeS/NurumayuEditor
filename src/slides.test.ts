import { describe, expect, it } from "vitest";
import {
  autoLayout,
  groupSlides,
  hasLayoutOverride,
  isSlideDetached,
  layoutHost,
  resolveLayout,
  slideBullets,
  slideImage,
  slideImages,
  slideMoveBounds,
  slideOverflows,
  slideSubtitle,
  slideTitle,
  splitImageRegion,
} from "./slides";
import type { Chunk, ChunkType, SlideLayout } from "./types";

function chunk(id: string, type: ChunkType, content = ""): Chunk {
  return { id, order: 0, content, metadata: { chunkType: type, linkedChunks: [] } };
}

describe("groupSlides", () => {
  it("starts a new slide at each heading", () => {
    const slides = groupSlides([
      chunk("h1", "heading", "Intro"),
      chunk("a", "text", "A"),
      chunk("b", "text", "B"),
      chunk("h2", "heading", "Details"),
      chunk("c", "text", "C"),
    ]);
    expect(slides).toHaveLength(2);
    expect(slides[0].items.map((c) => c.id)).toEqual(["h1", "a", "b"]);
    expect(slides[1].items.map((c) => c.id)).toEqual(["h2", "c"]);
  });

  it("puts content before the first heading on a heading-less leading slide", () => {
    const slides = groupSlides([
      chunk("a", "text", "lonely"),
      chunk("h1", "heading", "Section"),
    ]);
    expect(slides).toHaveLength(2);
    expect(slides[0].items.some((c) => c.metadata.chunkType === "heading")).toBe(false);
  });
});

describe("autoLayout (mirrors deck.rs)", () => {
  it("section when no body, title-content with body, title-image with an image", () => {
    expect(autoLayout([chunk("h", "heading", "T")])).toBe("section");
    expect(autoLayout([chunk("h", "heading", "T"), chunk("a", "text", "x")])).toBe(
      "title-content"
    );
    expect(autoLayout([chunk("h", "heading", "T"), chunk("i", "image", "u")])).toBe(
      "title-image"
    );
  });
});

describe("slideTitle / slideBullets (D2 — no double display)", () => {
  it("a heading slide titles from the heading; its text are bullets", () => {
    const [s] = groupSlides([chunk("h", "heading", "Title"), chunk("a", "text", "one")]);
    expect(slideTitle(s, "Doc")).toBe("Title");
    expect(slideBullets(s)).toEqual(["one"]);
  });

  it("a heading-less slide titles from the DOCUMENT title; its first paragraph is a bullet, not the title", () => {
    const [s] = groupSlides([chunk("a", "text", "first"), chunk("b", "text", "second")]);
    expect(slideTitle(s, "My Deck")).toBe("My Deck");
    // first paragraph appears once — as a bullet — never duplicated as the title.
    expect(slideBullets(s)).toEqual(["first", "second"]);
  });
});

describe("layout override (Req 1 — applies to any slide)", () => {
  const withLayout = (id: string, type: ChunkType, layout: SlideLayout): Chunk => {
    const c = chunk(id, type, "x");
    c.metadata.layout = layout;
    return c;
  };

  it("resolveLayout reads an override from the heading OR a heading-less slide's first chunk", () => {
    const s1 = groupSlides([withLayout("h", "heading", "section"), chunk("a", "text", "a")])[0];
    expect(resolveLayout(s1)).toBe("section");
    // heading-less leading slide — override lives on the first text chunk.
    const s2 = groupSlides([withLayout("t", "text", "title-image"), chunk("u", "text", "u")])[0];
    expect(resolveLayout(s2)).toBe("title-image");
    // no override → auto-pick.
    const s3 = groupSlides([chunk("x", "heading", "X"), chunk("y", "text", "y")])[0];
    expect(resolveLayout(s3)).toBe("title-content");
  });

  it("layoutHost is the heading, else the first chunk", () => {
    const s1 = groupSlides([chunk("h", "heading", "H"), chunk("a", "text", "a")])[0];
    expect(layoutHost(s1)?.id).toBe("h");
    const s2 = groupSlides([chunk("t", "text", "t"), chunk("u", "text", "u")])[0];
    expect(layoutHost(s2)?.id).toBe("t");
  });

  it("title-image-left and image-top pass through as overrides but are never auto-picked", () => {
    const s1 = groupSlides([withLayout("h", "heading", "title-image-left"), chunk("a", "text", "a")])[0];
    expect(resolveLayout(s1)).toBe("title-image-left");
    const s2 = groupSlides([withLayout("h", "heading", "image-top"), chunk("a", "text", "a")])[0];
    expect(resolveLayout(s2)).toBe("image-top");
    // An image with no override still auto-picks the "right" variant, not
    // either manual-only one.
    const s3 = groupSlides([chunk("h", "heading", "H"), chunk("i", "image", "u")])[0];
    expect(resolveLayout(s3)).toBe("title-image");
  });

  it("hasLayoutOverride tracks whether the slide has an explicit override (Auto vs. pinned)", () => {
    const withOverride = groupSlides([withLayout("h", "heading", "section"), chunk("a", "text", "a")])[0];
    expect(hasLayoutOverride(withOverride)).toBe(true);
    const auto = groupSlides([chunk("h", "heading", "H"), chunk("a", "text", "a")])[0];
    expect(hasLayoutOverride(auto)).toBe(false);
  });

  it("an empty-string layout is NOT an override (deck.rs parity)", () => {
    const h = chunk("h", "heading", "H");
    h.metadata.layout = "" as SlideLayout;
    const [s] = groupSlides([h, chunk("a", "text", "a")]);
    expect(hasLayoutOverride(s)).toBe(false);
    expect(resolveLayout(s)).toBe("title-content"); // auto-picked
    // …and a later REAL override still wins over an earlier empty one.
    const t = chunk("t", "text", "x");
    t.metadata.layout = "section";
    const [s2] = groupSlides([h, t]);
    expect(resolveLayout(s2)).toBe("section");
  });
});

describe("slideImages (multi-image grid contract — mirrors pptx.rs)", () => {
  const img = (id: string, content: string, slot?: number): Chunk => {
    const c = chunk(id, "image", content);
    if (slot !== undefined) c.metadata.slot = slot;
    return c;
  };

  it("orders by slot (lower first), ties by document order, slot-less last", () => {
    const [s] = groupSlides([
      chunk("h", "heading", "H"),
      img("a", "u1"), // no slot → last
      img("b", "u2", 1),
      img("c", "u3", 0),
      img("d", "u4", 1), // ties with b → document order
    ]);
    expect(slideImages(s).map((c) => c.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("skips empty-content images; slideImage stays the first visual", () => {
    const [s] = groupSlides([chunk("h", "heading", "H"), img("e", "  "), img("f", "url")]);
    expect(slideImages(s).map((c) => c.id)).toEqual(["f"]);
    expect(slideImage(s)).toBe("url");
  });
});

describe("splitImageRegion (mirrors the pptx.rs grid contract)", () => {
  it("n=1 fills the whole region on any image layout", () => {
    expect(splitImageRegion("title-image", 1)).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
    expect(splitImageRegion("image-top", 1)).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });

  it("a column region stacks 2 rows, then a row-major 2×2, then 2 cols × 3 rows", () => {
    expect(splitImageRegion("title-image", 2)).toEqual([
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 },
    ]); // stacked vertically
    expect(splitImageRegion("title-image", 3)).toHaveLength(3);
    const four = splitImageRegion("title-image-left", 4);
    expect(four).toHaveLength(4);
    expect(four[1]).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 }); // row-major fill
    expect(four[2]).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    const six = splitImageRegion("title-image", 6);
    expect(six).toHaveLength(6);
    expect(six[5]).toEqual({ x: 0.5, y: 2 / 3, w: 0.5, h: 1 / 3 }); // 2 cols × 3 rows
  });

  it("the top band goes side-by-side at 2, 2×2 at 3–4, 3 cols × 2 rows at 5–6", () => {
    expect(splitImageRegion("image-top", 2)).toEqual([
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ]); // side by side
    const three = splitImageRegion("image-top", 3);
    expect(three).toHaveLength(3);
    expect(three[2]).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 }); // 2×2, second row
    const six = splitImageRegion("image-top", 6);
    expect(six).toHaveLength(6);
    expect(six[3]).toEqual({ x: 0, y: 0.5, w: 1 / 3, h: 0.5 }); // 3 cols × 2 rows
  });

  it("caps at 6 cells; layouts without an image region get none", () => {
    expect(splitImageRegion("title-image", 9)).toHaveLength(6);
    expect(splitImageRegion("title-image", 0)).toEqual([]);
    expect(splitImageRegion("title-content", 3)).toEqual([]);
    expect(splitImageRegion("section", 1)).toEqual([]);
  });
});

describe("slideOverflows (ports the pptx.rs A7 heuristic)", () => {
  it("flags a bullet-heavy slide and passes a short one", () => {
    const short = groupSlides([chunk("h", "heading", "T"), chunk("a", "text", "one line")])[0];
    expect(slideOverflows(short)).toBe(false);
    const many = groupSlides([
      chunk("h", "heading", "T"),
      ...Array.from({ length: 15 }, (_, i) => chunk(`b${i}`, "text", "bullet")),
    ])[0];
    expect(slideOverflows(many)).toBe(true); // 15 lines > 14
  });

  it("uses the narrower 60-cpl budget only when an image actually shows", () => {
    const text = "x".repeat(60 * 15); // 15 lines in an image column…
    const withImage = groupSlides([
      chunk("h", "heading", "T"),
      chunk("a", "text", text),
      chunk("i", "image", "url"),
    ])[0]; // auto → title-image
    expect(slideOverflows(withImage)).toBe(true);
    const noImage = groupSlides([chunk("h", "heading", "T"), chunk("a", "text", text)])[0];
    expect(slideOverflows(noImage)).toBe(false); // …but ~9 at full width (110 cpl)
  });

  it("section slides never flag", () => {
    const s = groupSlides([chunk("h", "heading", "x".repeat(2000))])[0];
    expect(slideOverflows(s)).toBe(false);
  });
});

describe("subtitle (Req 3)", () => {
  it("an explicit subtitle chunk is the slide subtitle and is not a bullet", () => {
    const sub = chunk("s", "text", "My subtitle");
    sub.metadata.subtitle = true;
    const [slide] = groupSlides([chunk("h", "heading", "Title"), sub, chunk("b", "text", "Bullet one")]);
    expect(slideSubtitle(slide)).toBe("My subtitle");
    expect(slideBullets(slide)).toEqual(["Bullet one"]);
  });

  it("no explicit subtitle → undefined", () => {
    const [slide] = groupSlides([chunk("h", "heading", "T"), chunk("b", "text", "x")]);
    expect(slideSubtitle(slide)).toBeUndefined();
  });
});

describe("detach / slideBody (Req 2)", () => {
  it("a slideBody on the lead chunk overrides the bullets and marks the slide detached", () => {
    const h = chunk("h", "heading", "Title");
    h.metadata.slideBody = ["Sum A", "Sum B"];
    const [slide] = groupSlides([h, chunk("b", "text", "original prose")]);
    expect(isSlideDetached(slide)).toBe(true);
    expect(slideBullets(slide)).toEqual(["Sum A", "Sum B"]); // prose ignored
  });

  it("no slideBody → linked to the prose", () => {
    const [slide] = groupSlides([chunk("h", "heading", "T"), chunk("b", "text", "prose")]);
    expect(isSlideDetached(slide)).toBe(false);
    expect(slideBullets(slide)).toEqual(["prose"]);
  });

  it("a heading-less slide stores the override on its first chunk", () => {
    const t = chunk("t", "text", "lead");
    t.metadata.slideBody = ["S1"];
    const [slide] = groupSlides([t, chunk("u", "text", "more")]);
    expect(isSlideDetached(slide)).toBe(true);
    expect(slideBullets(slide)).toEqual(["S1"]);
  });
});

describe("slideMoveBounds (B2 — stay inside the slide)", () => {
  it("pins the heading and bounds the body to the slide", () => {
    const items = [
      chunk("h", "heading", "T"),
      chunk("a", "text", "a"),
      chunk("b", "text", "b"),
    ];
    expect(slideMoveBounds(items, 0)).toEqual({ canUp: false, canDown: false }); // heading
    expect(slideMoveBounds(items, 1)).toEqual({ canUp: false, canDown: true }); // first body
    expect(slideMoveBounds(items, 2)).toEqual({ canUp: true, canDown: false }); // last body
  });

  it("a heading-less slide moves all body chunks but not past the slide edges", () => {
    const items = [chunk("a", "text", "a"), chunk("b", "text", "b"), chunk("c", "text", "c")];
    expect(slideMoveBounds(items, 0)).toEqual({ canUp: false, canDown: true });
    expect(slideMoveBounds(items, 1)).toEqual({ canUp: true, canDown: true });
    expect(slideMoveBounds(items, 2)).toEqual({ canUp: true, canDown: false });
  });
});
