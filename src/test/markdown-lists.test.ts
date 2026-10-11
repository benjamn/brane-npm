import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { micromark } from "micromark";
import { gfmTaskListItem, gfmTaskListItemHtml } from "micromark-extension-gfm-task-list-item";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import {
  listIsLoose,
  listItemRowMarginTop,
  listParagraphOverride,
} from "../shared/markdown-lists.js";

// Lists are rendered twice by two unrelated pieces of machinery: micromark
// straight to HTML for the export, and mdast through react-native primitives
// for the app. Nothing forces them to agree, and the ways they can disagree are
// invisible in a unit test of either one alone — so the tests below check the
// app's inputs *against micromark's output*, which is the only shared ground.

function html(md: string): string {
  return micromark(md, {
    extensions: [gfmTaskListItem()],
    htmlExtensions: [gfmTaskListItemHtml()],
  });
}

function tree(md: string): any {
  return fromMarkdown(md, {
    extensions: [gfmTaskListItem()],
    mdastExtensions: [gfmTaskListItemFromMarkdown()],
  });
}

/** The first list in a document, as the app's renderer would receive it. */
function firstList(md: string): any {
  return tree(md).children.find((n: any) => n.type === "list");
}

/** Whether micromark wrapped this document's list items in paragraphs — its
 *  own, independent verdict on looseness, and the thing `listIsLoose` has to
 *  reproduce from the tree. */
function htmlIsLoose(md: string): boolean {
  return /<li>\n<p>/.test(html(md));
}

describe("task list items", () => {
  it("parses the checked state the app renders from", () => {
    const list = firstList("- [x] done\n- [ ] pending\n- plain\n");
    assert.deepEqual(
      list.children.map((i: any) => i.checked),
      [true, false, null],
    );
  });

  it("leaves `checked` null for an ordinary item, which is what keeps its bullet", () => {
    // The app swaps the marker for a checkbox on `checked != null`. `false` is
    // an unticked box and `null` is a bullet, so the two must not be conflated
    // — a `!checked` test would draw bullets over every unticked task.
    const list = firstList("- plain\n");
    assert.equal(list.children[0].checked, null);
  });

  it("accepts an uppercase X, as GFM does", () => {
    assert.equal(firstList("- [X] done\n").children[0].checked, true);
  });

  it("renders a real checkbox input in the export", () => {
    const out = html("- [x] done\n- [ ] pending\n");
    assert.match(out, /<li><input type="checkbox" disabled="" checked="" \/> done<\/li>/);
    assert.match(out, /<li><input type="checkbox" disabled="" \/> pending<\/li>/);
  });

  it("puts the input inside the paragraph when the list is loose", () => {
    // Both shapes exist, which is why src/export.ts needs two `list-style: none`
    // selectors rather than one.
    assert.match(html("- [x] one\n\n- [ ] two\n"), /<li>\n<p><input type="checkbox"/);
  });

  it("nests", () => {
    const list = firstList("- [ ] parent\n  - [x] child\n");
    assert.equal(list.children[0].checked, false);
    const nested = list.children[0].children.find((n: any) => n.type === "list");
    assert.equal(nested.children[0].checked, true);
  });

  it("does not fire on a bracket that isn't a task marker", () => {
    // `[x]` mid-item, and a link reference — neither is a checkbox.
    assert.equal(firstList("- see [x] here\n").children[0].checked, null);
    assert.doesNotMatch(html("- see [x] here\n"), /input type="checkbox"/);
  });
});

describe("listIsLoose", () => {
  // Each case is checked twice: once against micromark's HTML, which is what
  // the export ships, and once against `listIsLoose`, which is what the app
  // decides. A case where the two disagree is the bug this exists to catch.
  const cases: Array<[string, string]> = [
    ["tight", "- one\n- two\n"],
    ["loose", "- one\n\n- two\n"],
    ["tight, ordered", "1. one\n2. two\n"],
    ["loose, ordered", "1. one\n\n2. two\n"],
    ["tight task list", "- [x] one\n- [ ] two\n"],
    ["loose task list", "- [x] one\n\n- [ ] two\n"],
    ["single item", "- only\n"],
    ["item holding two blocks", "- one\n\n  still one\n- two\n"],
  ];

  for (const [name, md] of cases) {
    it(`agrees with micromark: ${name}`, () => {
      assert.equal(listIsLoose(firstList(md)), htmlIsLoose(md), md);
    });
  }

  it("is a property of the list, not of the item", () => {
    // CommonMark: one blank line anywhere makes the *whole* list loose, so the
    // second item gets paragraph margins even though it is not itself spread.
    // Reading `item.spread` per item — the obvious shortcut — would space the
    // two differently, and differently from the export.
    const list = firstList("- one\n\n  still one\n- two\n");
    assert.equal(list.children[1].spread, false);
    assert.equal(listIsLoose(list), true);
  });

  it("falls back to the child count for a hand-built tree", () => {
    assert.equal(listIsLoose({ children: [{ children: [{}, {}] }] }), true);
    assert.equal(listIsLoose({ children: [{ children: [{}] }] }), false);
  });

  it("treats a missing list as tight", () => {
    assert.equal(listIsLoose(undefined), false);
    assert.equal(listIsLoose(null), false);
  });
});

describe("list item marker alignment", () => {
  // A list item row is `[marker <Text>][content <View>]`, top-aligned, so a
  // margin *inside* the content column moves the text and leaves the marker
  // behind. These pin the arithmetic that keeps the two on the same line —
  // the defect was a `1.` sitting ~8px above the line it numbered, on every
  // item of every loose list.
  const PARA = 8; // styles.paragraph.marginVertical

  /** Where the marker and the item's first line land, in the row's own
   *  coordinates. `beforeFix` models what the renderer used to do: no margin on
   *  the row, the full paragraph margin on the first block. */
  function layout(loose: boolean, beforeFix = false) {
    const rowMarginTop = beforeFix ? 0 : listItemRowMarginTop(loose, PARA);
    const override = beforeFix
      ? loose
        ? null
        : { marginVertical: 0 }
      : listParagraphOverride({ inListItem: true, firstBlock: true, loose });
    const paraMarginTop =
      override && "marginVertical" in override
        ? override.marginVertical
        : override && "marginTop" in override
          ? override.marginTop
          : PARA;
    return { marker: rowMarginTop, text: rowMarginTop + paraMarginTop };
  }

  for (const loose of [false, true]) {
    it(`puts the marker on its own first line (${loose ? "loose" : "tight"})`, () => {
      const { marker, text } = layout(loose);
      assert.equal(marker, text);
    });
  }

  it("reproduces the defect it fixes", () => {
    // The guard against a "fix" that changes nothing: before, a loose item's
    // text sat a full paragraph margin below its marker.
    const before = layout(true, true);
    assert.equal(before.text - before.marker, PARA);
    // Tight lists were always fine — which is why this looked like a new bug.
    const tight = layout(false, true);
    assert.equal(tight.text - tight.marker, 0);
  });

  for (const loose of [false, true]) {
    it(`leaves the text exactly where it was (${loose ? "loose" : "tight"})`, () => {
      // The margin moved from the paragraph to the row; it was not removed. If
      // this drifts, loose lists have quietly retightened and the app no longer
      // matches the export.
      assert.equal(layout(loose).text, layout(loose, true).text);
    });
  }

  it("only the first block of an item gives up its top margin", () => {
    // `- one\n\n  still one` — the second paragraph sits below the marker, not
    // beside it, so it keeps the margin that separates the two blocks.
    assert.deepEqual(
      listParagraphOverride({ inListItem: true, firstBlock: false, loose: true }),
      null,
    );
    assert.deepEqual(
      listParagraphOverride({ inListItem: true, firstBlock: true, loose: true }),
      { marginTop: 0 },
    );
  });

  it("flattens every paragraph of a tight item, first or not", () => {
    for (const firstBlock of [true, false]) {
      assert.deepEqual(
        listParagraphOverride({ inListItem: true, firstBlock, loose: false }),
        { marginVertical: 0 },
      );
    }
  });

  it("leaves a paragraph outside any list alone", () => {
    for (const loose of [true, false]) {
      assert.equal(
        listParagraphOverride({ inListItem: false, firstBlock: true, loose }),
        null,
      );
    }
  });

  it("gives a tight row no margin of its own", () => {
    assert.equal(listItemRowMarginTop(false, PARA), 0);
    assert.equal(listItemRowMarginTop(true, PARA), PARA);
  });

  it("keeps the gap between loose items at what two paragraph margins gave", () => {
    // Item N's trailing paragraph margin plus item N+1's row margin. RN does no
    // margin collapsing, so this was 8+8 before and has to stay 8+8.
    assert.equal(PARA + listItemRowMarginTop(true, PARA), PARA + PARA);
  });
});
