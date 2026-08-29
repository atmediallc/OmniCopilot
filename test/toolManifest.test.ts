import { describe, expect, it } from "vitest";
import manifest from "../package.json";

interface ToolManifest {
  name: string;
  inputSchema: {
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  };
}

const tools = (manifest.contributes.languageModelTools as unknown as ToolManifest[]);

describe("language model tool manifest", () => {
  it("declares exactly the fixed OmniRoute Search and Rerank tools", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["omniroute-dev_search", "omniroute-dev_rerank"]);
    expect(tools).toHaveLength(2);
  });

  it("declares the bounded public Search schema without an upstream provider field", () => {
    const schema = tools[0].inputSchema;
    expect(schema.required).toEqual(["query"]);
    expect(schema.properties.query).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    expect(schema.properties.max_results).toMatchObject({ type: "integer", minimum: 1, maximum: 100, default: 5 });
    expect(schema.properties.search_type).toMatchObject({ enum: ["web", "news"], default: "web" });
    expect(Object.keys(schema.properties)).toEqual(["query", "model", "routeId", "max_results", "search_type"]);
  });

  it("declares string documents and required Rerank fields", () => {
    const schema = tools[1].inputSchema;
    expect(schema.required).toEqual(["query", "documents"]);
    expect(schema.properties.documents).toMatchObject({ type: "array", minItems: 1, items: { type: "string" } });
    expect(schema.properties.top_n).toMatchObject({ type: "integer", minimum: 1 });
    expect(schema.properties.return_documents).toEqual({ type: "boolean" });
  });
});
