import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Connector } from "./connector.js";
import { IPart } from "../core/interfaces.js";

export class Part extends SceneObject implements IPart {
  constructor(public partName: string) {
    super();
    this.name(partName);
    this.setAlwaysVisible();
  }

  isContainer(): boolean {
    return true;
  }

  build(_context?: BuildSceneObjectContext): void {
    // No-op — children produce geometry
  }

  compareTo(other: Part): boolean {
    if (!(other instanceof Part)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.partName !== other.partName) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "part";
  }

  getConnectors(): Connector[] {
    return this.getChildren().filter(c => c instanceof Connector) as Connector[];
  }

  /**
   * The part's connectors keyed by the name each `connector('name', …)`
   * statement registered. Mates reference connectors through this map
   * (`instance.connectors.main`), so the binding is robust to source
   * reordering inside the part — adding or moving a `connector(...)` call
   * doesn't shuffle which name maps to which connector. Uniqueness is
   * enforced at creation time by `connector()`.
   */
  getNamedConnectors(): Record<string, Connector> {
    const out: Record<string, Connector> = {};
    for (const c of this.getConnectors()) {
      out[c.connectorName] = c;
    }
    return out;
  }

  serialize() {
    return {
      name: this.partName,
    };
  }
}
