// Ambient types for the Extism JS PDK runtime (QuickJS) globals used by this plugin.
// Equivalent to the subset of @extism/js-pdk that we need.

declare type I32 = number;
declare type I64 = number | bigint;
declare type PTR = I64;

interface MemoryHandle {
  offset: PTR;
  readString(): string;
  free(): void;
}

declare const Host: {
  inputString(): string;
  outputString(output: string): boolean;
  getFunctions(): { httpRequest(ptr: PTR): I64 };
};

declare const console: {
  log(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const Memory: {
  fromString(value: string): MemoryHandle;
  find(offset: PTR): MemoryHandle;
};
