import { describe, expect, it, vi } from "vitest";
import { OmniRouteChatProvider } from "../src/provider";
import type { OmniRouteCatalogEntry } from "../src/routes";

function mockContext() {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as any;
}

describe("OmniRouteChatProvider", () => {
  it("can be instantiated with dependencies", () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      outputChannel: { appendLine: () => {} } as any,
    });
    expect(provider).toBeDefined();
  });
});
