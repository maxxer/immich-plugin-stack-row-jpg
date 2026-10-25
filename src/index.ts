/**
 * Immich workflow plugin entry point (compiled to WebAssembly with extism-js).
 *
 * Mirrors the calling convention of @immich/plugin-sdk (wrapper + host functions) but only
 * depends on the Extism JS PDK runtime globals, so it builds outside the Immich monorepo.
 */
import { resolveConfig, type AssetLike } from './matching.ts';
import { stackAsset, type HttpRequest } from './stacker.ts';

type WorkflowPayload = {
  trigger: string;
  type: string;
  config: Record<string, unknown> | null;
  data: { asset: AssetLike };
  workflow: { id: string; authToken: string; stepId: string; debug?: boolean };
};

type HostResult<T> = { success: true; response: T } | { success: false; status: number; message: unknown };

const callHost = <T>(name: 'httpRequest', authToken: string, args: unknown[]): T => {
  const host = Host.getFunctions();
  const input = Memory.fromString(JSON.stringify({ authToken, args }));
  const output = Memory.find(host[name](input.offset));
  try {
    const result = JSON.parse(output.readString()) as HostResult<T>;
    if (result.success) {
      return result.response;
    }
    throw new Error(`Host function "${name}" failed with ${result.status}: ${JSON.stringify(result.message)}`);
  } finally {
    output.free();
    input.free();
  }
};

export function stackRawJpg() {
  const payload = JSON.parse(Host.inputString()) as WorkflowPayload;
  const config = resolveConfig(payload.config);
  const request: HttpRequest = (url, options) => callHost('httpRequest', payload.workflow.authToken, [url, options]);
  const log = {
    debug: (message: string) => console.debug(message),
    info: (message: string) => console.log(message),
  };

  const result = stackAsset(payload.data.asset, config, request, log);

  // never halt the workflow: later steps should still run for unpaired files
  const response = { workflow: { continue: true }, data: { rawJpgStacker: result } };
  Host.outputString(JSON.stringify(response));
}
