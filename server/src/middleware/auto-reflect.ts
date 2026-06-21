// auto-reflect.ts — entry point. Implementation split into reflect/ directory.
// Reference: auto-reflect.v10-stable.ts (stable snapshot before split)
export { runAutoReflect, getReflectLogPath } from "./reflect/pipeline.js";
export { reflectTokenStats } from "./reflect/context.js";
export type { ReflectCreatedBlock, ReflectUpdatedBlock, ReflectResult } from "./reflect/types.js";
