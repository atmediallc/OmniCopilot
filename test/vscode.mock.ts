/** Minimal stand-in for the "vscode" module so convert.ts can run under vitest.
 * Mirrors only the classes/enums the conversion layer touches. */

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
  System = 3,
}

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[]
  ) {}
}

export class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string
  ) {}

  static image(data: Uint8Array, mimeType: string): LanguageModelDataPart {
    return new LanguageModelDataPart(data, mimeType);
  }
}

export enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}
