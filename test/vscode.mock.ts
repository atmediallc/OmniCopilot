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

export class EventEmitter<T> {
  private listeners: Array<(e: T) => unknown> = [];
  event = (listener: (e: T) => unknown) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }
  dispose(): void {}
}

export const l10n = {
  t: (message: string | { message: string; args?: unknown[] }, ...args: unknown[]): string => {
    let msg = typeof message === "string" ? message : message.message;
    const finalArgs = typeof message === "object" && message.args ? message.args : args;
    finalArgs.forEach((arg, idx) => {
      msg = msg.replace(`{${idx}}`, String(arg));
    });
    return msg;
  },
};

export const workspace = {
  getConfiguration: (_section?: string) => {
    return {
      get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
    };
  },
};

