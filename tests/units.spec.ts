/**
 * Direct logic tests for unit summing / postProcess family splits.
 * No browser — imports app/lib pure helpers.
 */
import { expect, test } from "@playwright/test";
import {
  normalizeUnit,
  unitFamily,
  sumCompatibleAmounts,
  pickReadableDisplay,
} from "../app/lib/units";
import { postProcess, type DedupInput, type RawMerges } from "../app/lib/dedup";

test.describe("normalizeUnit", () => {
  const cases: [string | null, string | null][] = [
    [null, null],
    ["", null],
    ["  G  ", "g"],
    ["grams", "g"],
    ["kilograms", "kg"],
    ["Cups", "cup"],
    ["tassen", "cup"],
    ["EL", "tbsp"],
    ["tl", "tsp"],
    ["ounces", "oz"],
    ["lbs", "lb"],
    ["pinches", "pinch"],
    ["millilitres", "ml"],
    ["Stück", "stück"],
    ["stk", "stück"],
    ["piece", "stück"],
    ["pieces", "stück"],
    ["bunch", "bunch"], // unknown — unchanged
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeUnit(input)).toBe(expected);
    });
  }
});

test.describe("unitFamily — never cross", () => {
  test("mass ≠ volume", () => {
    expect(unitFamily("g")).toBe("mass");
    expect(unitFamily("cups")).toBe("volume");
    expect(unitFamily("g")).not.toBe(unitFamily("cups"));
  });
  test("pinch ≠ tsp", () => {
    expect(unitFamily("pinch")).toBe("q:pinch");
    expect(unitFamily("tsp")).toBe("tsp_tbsp");
    expect(unitFamily("pinch")).not.toBe(unitFamily("tsp"));
  });
  test("unknowns stay separate", () => {
    expect(unitFamily("bundle")).toBe("u:bundle");
    expect(unitFamily("bunch")).toBe("u:bunch");
    expect(unitFamily("bundle")).not.toBe(unitFamily("bunch"));
  });
  test("cup synonyms share volume", () => {
    expect(unitFamily("cup")).toBe("volume");
    expect(unitFamily("cups")).toBe("volume");
    expect(unitFamily("tasse")).toBe("volume");
    expect(unitFamily("ml")).toBe("volume");
  });
  test("count for empty", () => {
    expect(unitFamily(null)).toBe("count");
    expect(unitFamily("")).toBe("count");
  });
  test("Stück / piece share count with empty", () => {
    expect(unitFamily("Stück")).toBe("count");
    expect(unitFamily("stk")).toBe("count");
    expect(unitFamily("piece")).toBe("count");
    expect(unitFamily("pieces")).toBe("count");
    expect(unitFamily("Stück")).toBe(unitFamily(null));
  });
});

test.describe("sumCompatibleAmounts", () => {
  test("500 g + 1 kg → 1.5 kg", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "500", unit: "g" },
        { amount: "1", unit: "kg" },
      ]),
    ).toEqual({ amount: "1.5", unit: "kg" });
  });

  test("500 ml + 1 l → 1.5 l", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "500", unit: "ml" },
        { amount: "1", unit: "l" },
      ]),
    ).toEqual({ amount: "1.5", unit: "l" });
  });

  test("1 tbsp + 2 tsp → 5 tsp", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "1", unit: "tbsp" },
        { amount: "2", unit: "tsp" },
      ]),
    ).toEqual({ amount: "5", unit: "tsp" });
  });

  test("200 gram + 300 g → 500 g", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "200", unit: "gram" },
        { amount: "300", unit: "g" },
      ]),
    ).toEqual({ amount: "500", unit: "g" });
  });

  test("1 cup + 2 cups → 3 cups", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "1", unit: "cup" },
        { amount: "2", unit: "cups" },
      ]),
    ).toEqual({ amount: "3", unit: "cups" });
  });

  test("1 cup + 240 ml → 480 ml (metric source → ml display)", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "1", unit: "cup" },
        { amount: "240", unit: "ml" },
      ]),
    ).toEqual({ amount: "480", unit: "ml" });
  });

  test("same-unit g sum stays g below 1 kg", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "300", unit: "g" },
        { amount: "300", unit: "g" },
      ]),
    ).toEqual({ amount: "600", unit: "g" });
  });

  test("1 pinch + 1 pinch → 2 pinches", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "1", unit: "pinch" },
        { amount: "1", unit: "pinches" },
      ]),
    ).toEqual({ amount: "2", unit: "pinches" });
  });

  test("null amount propagates", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "100", unit: "g" },
        { amount: null, unit: "g" },
      ]),
    ).toEqual({ amount: null, unit: "g" });
  });

  test("unparseable amount propagates null", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "100", unit: "g" },
        { amount: "a bit", unit: "g" },
      ]),
    ).toEqual({ amount: null, unit: "g" });
  });

  test("count (unitless) sums", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "2", unit: null },
        { amount: "3", unit: "" },
      ]),
    ).toEqual({ amount: "5", unit: null });
  });

  test("unitless + Stück sums as count", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "3", unit: null },
        { amount: "1", unit: "Stück" },
      ]),
    ).toEqual({ amount: "4", unit: null });
  });

  test("Stück + piece sums as count", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "2", unit: "Stück" },
        { amount: "1", unit: "piece" },
      ]),
    ).toEqual({ amount: "3", unit: null });
  });

  test("German el + tl → tsp family", () => {
    expect(
      sumCompatibleAmounts([
        { amount: "1", unit: "el" },
        { amount: "2", unit: "tl" },
      ]),
    ).toEqual({ amount: "5", unit: "tsp" });
  });

  test("order does not matter (commutative)", () => {
    const a = sumCompatibleAmounts([
      { amount: "1", unit: "kg" },
      { amount: "500", unit: "g" },
    ]);
    const b = sumCompatibleAmounts([
      { amount: "500", unit: "g" },
      { amount: "1", unit: "kg" },
    ]);
    expect(a).toEqual(b);
  });
});

test.describe("pickReadableDisplay", () => {
  test("1500 g → 1.5 kg", () => {
    expect(pickReadableDisplay(1500, "mass", ["g", "g"])).toEqual({
      amount: "1.5",
      unit: "kg",
    });
  });

  test("3000 g → 3 kg", () => {
    expect(pickReadableDisplay(3000, "mass", ["g"])).toEqual({
      amount: "3",
      unit: "kg",
    });
  });

  test("48 tsp → 16 tbsp", () => {
    expect(pickReadableDisplay(48, "tsp_tbsp", ["tsp"])).toEqual({
      amount: "16",
      unit: "tbsp",
    });
  });

  test("5 tsp stays tsp", () => {
    expect(pickReadableDisplay(5, "tsp_tbsp", ["tbsp", "tsp"])).toEqual({
      amount: "5",
      unit: "tsp",
    });
  });
});

test.describe("postProcess family split", () => {
  test("g flour + cups flour → two groups", () => {
    const input: DedupInput = {
      items: [
        {
          id: "a",
          amount: "200",
          unit: "g",
          item: "flour",
          recipeName: "Bread",
        },
        {
          id: "b",
          amount: "2",
          unit: "cups",
          item: "flour",
          recipeName: "Pancakes",
        },
      ],
    };
    const raw: RawMerges = { merges: [{ ids: ["a", "b"] }] };
    const groups = postProcess(input, raw);
    expect(groups).toHaveLength(2);
    const texts = groups.map((g) => g.displayText).sort();
    expect(texts).toEqual(["2 cups flour", "200 g flour"]);
  });

  test("pinch salt + tsp salt → two groups", () => {
    const input: DedupInput = {
      items: [
        {
          id: "a",
          amount: "1",
          unit: "pinch",
          item: "salt",
          recipeName: "A",
        },
        {
          id: "b",
          amount: "1",
          unit: "tsp",
          item: "salt",
          recipeName: "B",
        },
      ],
    };
    const groups = postProcess(input, { merges: [{ ids: ["a", "b"] }] });
    expect(groups).toHaveLength(2);
  });

  test("500 g sugar + 1 kg sugar → 1.5 kg sugar", () => {
    const input: DedupInput = {
      items: [
        {
          id: "a",
          amount: "500",
          unit: "g",
          item: "sugar",
          recipeName: "Cake",
        },
        {
          id: "b",
          amount: "1",
          unit: "kg",
          item: "sugar",
          recipeName: "Cookies",
        },
      ],
    };
    const groups = postProcess(input, { merges: [{ ids: ["a", "b"] }] });
    expect(groups).toHaveLength(1);
    expect(groups[0].displayText).toBe("1.5 kg sugar");
    expect(groups[0].amount).toBe("1.5");
    expect(groups[0].unit).toBe("kg");
  });

  test("1 tbsp oil + 2 tsp oil → 5 tsp oil", () => {
    const input: DedupInput = {
      items: [
        {
          id: "a",
          amount: "1",
          unit: "tbsp",
          item: "oil",
          recipeName: "A",
        },
        {
          id: "b",
          amount: "2",
          unit: "tsp",
          item: "oil",
          recipeName: "B",
        },
      ],
    };
    const groups = postProcess(input, { merges: [{ ids: ["a", "b"] }] });
    expect(groups).toHaveLength(1);
    expect(groups[0].displayText).toBe("5 tsp oil");
  });

  test("3 Peperoni + 1 Stück Peperoni → 4 Peperoni", () => {
    const input: DedupInput = {
      items: [
        {
          id: "a",
          amount: "3",
          unit: null,
          item: "Peperoni",
          recipeName: "A",
        },
        {
          id: "b",
          amount: "1",
          unit: "Stück",
          item: "Peperoni",
          recipeName: "B",
        },
      ],
    };
    const groups = postProcess(input, { merges: [{ ids: ["a", "b"] }] });
    expect(groups).toHaveLength(1);
    expect(groups[0].amount).toBe("4");
    expect(groups[0].unit).toBeNull();
    expect(groups[0].displayText).toBe("4 Peperoni");
  });
});
