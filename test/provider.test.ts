import { describe, expect, it } from "vitest";
import { OmniRouteChatProvider } from "../src/provider";

function mockContext() {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as unknown as ConstructorParameters<typeof OmniRouteChatProvider>[0]["context"];
}

describe("OmniRouteChatProvider", () => {
  it("can be instantiated with dependencies", () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      outputChannel: { appendLine: () => {} } as unknown as ConstructorParameters<typeof OmniRouteChatProvider>[0]["log"],
    });
    expect(provider).toBeDefined();
  });
});
