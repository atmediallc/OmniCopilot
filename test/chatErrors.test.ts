import { describe, expect, it } from "vitest";
import { actionableFailureMessage } from "../src/chatErrors";
import { OmniRouteError } from "../src/client";
import { ContextBudgetError } from "../src/contextBudget";

describe("actionableFailureMessage", () => {
  it("points 401/403 at the API key command", () => {
    const msg = actionableFailureMessage(new OmniRouteError("Invalid API key", 401), "m", "Home");
    expect(msg).toContain("API key");
    expect(msg).toContain("Home");
    expect(msg).toContain("Set API Key");
  });

  it("points 404 model errors at refreshing the catalog", () => {
    const msg = actionableFailureMessage(
      new OmniRouteError("MODEL_001 model_not_found", 404),
      "ghost/model"
    );
    expect(msg).toContain("ghost/model");
    expect(msg).toContain("Refresh Models");
  });

  it("tells busy servers to wait instead of hammering", () => {
    const msg = actionableFailureMessage(new OmniRouteError("busy", 503), "m");
    expect(msg).toContain("busy or rate-limited");
  });

  it("explains stalls are not retried to avoid double billing", () => {
    const msg = actionableFailureMessage(new OmniRouteError("silent", 408, true), "m");
    expect(msg).toContain("NOT retried");
  });

  it("explains context overflow with concrete levers", () => {
    const msg = actionableFailureMessage(
      new ContextBudgetError("PROTECTED_CONTEXT_OVERFLOW", "overflow"),
      "small/model"
    );
    expect(msg).toContain("small/model");
    expect(msg).toContain("maxTools");
  });

  it("falls back to the raw message for unknown errors", () => {
    expect(actionableFailureMessage(new Error("weird"), "m")).toBe("weird");
  });
});
