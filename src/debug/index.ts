export type { DebugTracer, DebugEvent, TraceFile } from './types.js';
export { createNoopTracer } from './noop-tracer.js';
export { createFileTracer } from './file-tracer.js';

import { createFileTracer } from './file-tracer.js';
import { createNoopTracer } from './noop-tracer.js';
import type { DebugTracer } from './types.js';

export function createTracer(debug: boolean, stateDir: string): DebugTracer {
  return debug ? createFileTracer(stateDir) : createNoopTracer();
}
