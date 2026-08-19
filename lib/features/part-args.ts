// materializePartArgs lives here — a leaf module — rather than in
// part-definition.ts, because its importers include leaf modules
// (face/edge filters, core transforms) while part-definition pulls in
// the whole rendering layer. Routed through part-definition this was an
// ESM cycle: with a filter module as the import entry point,
// assembly-scene evaluated before rendering/scene finished ("Class
// extends value undefined"). PartDefinition registers itself at load
// time instead; if part-definition was never loaded, no PartDefinition
// instances can exist and the mapping is the identity.

import type { PartDefinition } from "./part-definition.js";

let partDefinitionClass: typeof PartDefinition | null = null;

export function registerPartDefinitionClass(cls: typeof PartDefinition): void {
  partDefinitionClass = cls;
}

export function materializePartArgs(args: unknown[]): any[] {
  const cls = partDefinitionClass;
  if (!cls) {
    return args as any[];
  }
  return args.map(a => (a instanceof cls ? a.materialize() : a));
}
