import * as vscode from 'vscode';

type SceneObject = {
  id: string;
  name: string;
  parentId: string | null;
  object: any;
  ownShapes: any[];
  sceneShapes: any[];
  visible: boolean;
  type: string;
  fromCache: boolean;
  isShape: boolean;
  hasError: boolean;
  sourceLocation?: { filePath: string; line: number; column: number };
}

type ShapeTreeItem = ShapeTypeGroupTreeItem | SceneShapeTreeItem;

export class SceneShapesProvider implements vscode.TreeDataProvider<ShapeTreeItem> {
  constructor(private context: vscode.ExtensionContext, private scene: SceneObject[]) { }

  getTreeItem(element: ShapeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ShapeTreeItem): Thenable<ShapeTreeItem[]> {
    if (!element) {
      const shapes = this.scene.flatMap(obj => obj.sceneShapes);

      const groups = new Map<string, { obj: SceneObject; shapeId: string }[]>();
      for (let i = 0; i < shapes.length; i++) {
        const type = shapes[i].shapeType || 'unknown';
        if (!groups.has(type)) {
          groups.set(type, []);
        }
        groups.get(type)!.push({ obj: shapes[i], shapeId: shapes[i].shapeId || `unknown-${i}` });
      }

      return Promise.resolve(
        Array.from(groups.entries()).map(
          ([type, shapes]) => new ShapeTypeGroupTreeItem(this.context, type, shapes)
        )
      );
    }
    else if (element instanceof ShapeTypeGroupTreeItem) {
      return Promise.resolve(
        element.shapes.map(({ obj, shapeId }, index) => new SceneShapeTreeItem(this.context, obj, shapeId, index))
      );
    }
    else {
      return Promise.resolve([]);
    }
  }
}

class ShapeTypeGroupTreeItem extends vscode.TreeItem {
  constructor(
    public context: vscode.ExtensionContext,
    public shapeType: string,
    public shapes: { obj: any; shapeId: string }[],
  ) {
    const capitalized = shapeType.charAt(0).toUpperCase() + shapeType.slice(1);
    super(capitalized, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${shapes.length}`;
  }
}

class SceneShapeTreeItem extends vscode.TreeItem {
  constructor(
    public context: vscode.ExtensionContext,
    public obj: any,
    public shapeId: string,
    public index: number,
  ) {
    super(`${obj.shapeType} ${index + 1}`, vscode.TreeItemCollapsibleState.None);
    this.iconPath = this.context.asAbsolutePath(`resources/icons/${obj.shapeType}.png`);
    this.contextValue = 'shape';
    this.command = {
      command: 'fluidcad.highlight_shape',
      title: 'Highlight Shape',
      arguments: [shapeId]
    };
  }
}

export class SceneHistoryProvider implements vscode.TreeDataProvider<SceneObjectTreeItem> {
  constructor(private context: vscode.ExtensionContext, private scene: any, private rollbackStop: number) { }

  getTreeItem(element: SceneObjectTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SceneObjectTreeItem): Thenable<SceneObjectTreeItem[]> {
    if (!element) {
      const getIndex = (obj: SceneObject) => {
        return this.scene.findIndex((o: SceneObject) => o.id === obj.id);
      };

      const sceneItems = this.scene.filter((obj: SceneObject) => !obj.parentId);
      const items = sceneItems.map((obj: SceneObject, index: number) => {
        const hasChildren = this.scene.some((o: SceneObject) => o.parentId === obj.id);
        return new SceneObjectTreeItem(this.context, obj, getIndex(obj) === this.rollbackStop, hasChildren);
      });

      return Promise.resolve(items);
    }
    else {
      console.log('Getting children for:', element.obj.id);
      const children = this.scene.filter((o: SceneObject) => o.parentId === element.obj.id);
      console.log('Children found:', children);
      const items = children.map((obj: SceneObject) => {
        const hasChildren = this.scene.some((o: SceneObject) => o.parentId === obj.id);
        return new SceneObjectTreeItem(this.context, obj, false, hasChildren);
      });
      return Promise.resolve(items);
    }
  }
}

class SceneObjectTreeItem extends vscode.TreeItem {
  constructor(
    public context: vscode.ExtensionContext,
    public obj: SceneObject,
    public isCurrent: boolean,
    public hasChildren: boolean
  ) {
    const capitlizedName = obj.name.charAt(0).toUpperCase() + obj.name.slice(1);
    const collapsibleState = hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
    super(capitlizedName, collapsibleState);
    this.iconPath = this.context.asAbsolutePath(`resources/icons/${obj.type}.png`);
    this.tooltip = obj.visible ? 'Visible' : 'Hidden';
    this.resourceUri = vscode.Uri.parse(`fluidcad:${obj.type}/${obj.visible}/${obj.fromCache}/${obj.hasError}/${isCurrent}`); // Example URI
    //
    this.description = this.getDescription(obj);
    this.command = {
      command: 'fluidcad.rollback',
      title: 'Rollback to this',
      arguments: [obj]
    };
  }

  private getDescription(obj: SceneObject): string {
    const options = obj.object.options || {};

    if (obj.type === 'extrude') {
      const parts: string[] = [];
      if (obj.object.distance) {
        parts.push(`${obj.object.symmetric ? '↕' : '↑'}${obj.object.distance}`);
      }
      if (obj.object.face) {
        parts.push(`⤒ until: ${obj.object.face}`);
      }
      if (options.draft) {
        parts.push(`⏢ ${options.draft}`);
      }

      return parts.join(' 🞄 ');
    }
    else if (obj.type === 'plane') {
      const parts: string[] = [];

      const normal = obj.object.normal;
      if (normal.x === 0 && normal.y === 0 && normal.z === 1) {
        parts.push('xy');
      }
      else if (normal.x === 0 && normal.y === 1 && normal.z === 0) {
        parts.push('xz');
      }
      else if (normal.x === 1 && normal.y === 0 && normal.z === 0) {
        parts.push('yz');
      }

      if (options.rotateX) {
        parts.push(`rx: ${options.rotateX}°`);
      }
      if (options.rotateY) {
        parts.push(`ry: ${options.rotateY}°`);
      }
      if (options.rotateZ) {
        parts.push(`rz: ${options.rotateZ}°`);
      }
      if (options.offset) {
        parts.push(`↑${options.offset}`);
      }

      return parts.join(' 🞄 ');
    }

    else if (obj.type === 'select') {
      let type = obj.object.type;
      if (obj.object.selectionLength > 1) {
        type += 's';
      }

      return `${obj.object.selectionLength} ${type}`;
    }
    else if (obj.type === 'fillet') {
      return `⊙${obj.object.radius}`;
    }
    else if (obj.type === 'chamfer') {
      return `🡾${obj.object.distance}`;
    }
  }
}
