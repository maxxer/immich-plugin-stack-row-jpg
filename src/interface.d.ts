// Interface file for extism-js: declares the host functions we import and the methods we export.
declare module 'extism:host' {
  interface user {
    httpRequest(ptr: PTR): I64;
  }
}

declare module 'main' {
  export function stackRawJpg(): I32;
}
