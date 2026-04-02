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
  errorMessage?: string;
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
        if (shapes[i].isMetaShape) {
          continue;
        }

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
