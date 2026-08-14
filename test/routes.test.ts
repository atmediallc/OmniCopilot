import { describe, expect, it } from "vitest";
import { newRouteId } from "../src/routes";

describe("newRouteId", () => {
  it("incrementa sobre ids route-N existentes", () => {
    expect(newRouteId([{ id: "route-1", name: "a", baseUrl: "x" }])).toBe("route-2");
  });
  it("salta ids no numéricos sin romper", () => {
    expect(newRouteId([{ id: "abc", name: "a", baseUrl: "x" }])).toBe("route-1");
  });
});