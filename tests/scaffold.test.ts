import { describe, expect, it } from "vitest";

import { packageName } from "../src/index.js";

describe("project scaffold", () => {
  it("exports the package name", () => {
    expect(packageName).toBe("@datalox/molecule-biology");
  });
});
