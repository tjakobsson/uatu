import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { SUPERSEDED_ATTRIBUTE, markSupersededDayLabels } from "./pinned-day";

// Three separators with an item between each; `tops` places each label
// (22px tall), as layout would after a scroll.
const timeline = (tops: number[]) => {
  const { document } = parseHTML("<!doctype html><html><body><div id=\"items\"></div></body></html>");
  const items = document.querySelector("#items")!;
  items.innerHTML = tops.map((_, index) => `<div class="chat-day-separator" data-chat-day="d${index}"><time>Day ${index}</time></div><div data-chat-item-id="m${index}">text</div>`).join("");
  const separators = Array.from(items.querySelectorAll<HTMLElement>(".chat-day-separator"));
  separators.forEach((separator, index) => {
    (separator.querySelector("time") as unknown as { getBoundingClientRect: () => Partial<DOMRect> }).getBoundingClientRect = () => ({ top: tops[index]!, bottom: tops[index]! + 22 });
  });
  const superseded = () => separators.map(separator => separator.hasAttribute(SUPERSEDED_ATTRIBUTE));
  return { items: items as unknown as HTMLElement, superseded };
};

test("a pinned label is superseded once the next day's label reaches it", () => {
  // Reading the middle day: the first day's label is pinned under it.
  const reading = timeline([16, 16, 900]);
  markSupersededDayLabels(reading.items);
  expect(reading.superseded()).toEqual([true, false, false]);

  // The last day's label slides up into the pinned one: only one shows.
  const arriving = timeline([16, 16, 30]);
  markSupersededDayLabels(arriving.items);
  expect(arriving.superseded()).toEqual([true, true, false]);
});

test("labels apart from each other are all shown, and a label comes back when the next one leaves it", () => {
  const view = timeline([16, 400, 900]);
  markSupersededDayLabels(view.items);
  expect(view.superseded()).toEqual([false, false, false]);

  const back = timeline([16, 16, 900]);
  markSupersededDayLabels(back.items);
  expect(back.superseded()).toEqual([true, false, false]);
  // Scrolled back up past the middle day's start: the first day is read again.
  const times = Array.from(back.items.querySelectorAll("time")) as unknown as { getBoundingClientRect: () => Partial<DOMRect> }[];
  times[1]!.getBoundingClientRect = () => ({ top: 200, bottom: 222 });
  markSupersededDayLabels(back.items);
  expect(back.superseded()).toEqual([false, false, false]);
});
