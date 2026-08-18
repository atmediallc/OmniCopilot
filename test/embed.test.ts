import { describe, expect, it } from "vitest";
import { isFramingAllowed } from "../src/embed";

const h = (obj: Record<string, string>) => new Headers(obj);

describe("isFramingAllowed", () => {
  it("blocks the real default OmniRoute serves (measured on 192.168.0.17)", () => {
    expect(
      isFramingAllowed(
        h({
          "x-frame-options": "DENY",
          "content-security-policy":
            "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
        })
      )
    ).toBe(false);
  });

  it("allows the shape DASHBOARD_ALLOW_EMBED=vscode produces", () => {
    expect(
      isFramingAllowed(
        h({ "content-security-policy": "default-src 'self'; frame-ancestors 'self' vscode-webview:" })
      )
    ).toBe(true);
  });

  it("treats SAMEORIGIN as a block — the webview is a different origin", () => {
    expect(isFramingAllowed(h({ "x-frame-options": "SAMEORIGIN" }))).toBe(false);
  });

  it("blocks frame-ancestors 'none' even without X-Frame-Options", () => {
    expect(isFramingAllowed(h({ "content-security-policy": "frame-ancestors 'none'" }))).toBe(false);
  });

  it("blocks frame-ancestors 'self' — self is not the webview origin", () => {
    expect(isFramingAllowed(h({ "content-security-policy": "frame-ancestors 'self'" }))).toBe(false);
  });

  it("allows a wildcard", () => {
    expect(isFramingAllowed(h({ "content-security-policy": "frame-ancestors *" }))).toBe(true);
  });

  it("allows when no framing header is present at all", () => {
    expect(isFramingAllowed(h({}))).toBe(true);
    expect(isFramingAllowed(h({ "content-security-policy": "default-src 'self'" }))).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isFramingAllowed(h({ "x-frame-options": "  deny  " }))).toBe(false);
    expect(
      isFramingAllowed(h({ "content-security-policy": "  FRAME-ANCESTORS   VSCODE-WEBVIEW:  " }))
    ).toBe(true);
  });
});
