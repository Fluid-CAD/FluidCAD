import { join } from 'path';
import { existsSync } from 'fs';
import { ViteManager } from './vite-manager.ts';

type SceneManager = {
  startScene(): any;
  renderScene(scene: any): any;
  rollbackScene(scene: any, rollbackIndex: number): any;
  compare(previousScene: any, currentScene: any): any;
  importFile(workspacePath: string, fileName: string, data: Uint8Array): any;
};

export type SceneRenderedData = {
  absPath: string;
  result: any[];
  rollbackStop: number;
};

export class FluidCadServer {
  private viteManager = new ViteManager();
  private sceneManager: SceneManager | undefined;
  private previousScenes: Map<string, any> = new Map();
  private renderingCache = new Map<string, any[]>();
  private currentFileName: string = '';

  async init(workspacePath: string) {
    await this.viteManager.init(workspacePath);

    const initFilePath = join(workspacePath, 'init.js');
    if (existsSync(initFilePath)) {
      const { default: _sceneManager } = await this.viteManager.loadModule(initFilePath);
      this.sceneManager = await _sceneManager;
    }
  }

  async processFile(filePath: string, ignoreCache = false): Promise<SceneRenderedData | null> {
    if (!this.sceneManager) {
      return null;
    }

    const normalizedFileName = filePath.replace('virtual:live-render:', '');
    this.currentFileName = normalizedFileName;

    if (!ignoreCache) {
      const fromCache = this.renderingCache.get(normalizedFileName);
      if (fromCache) {
        return {
          absPath: normalizedFileName,
          result: fromCache,
          rollbackStop: fromCache.length - 1,
        };
      }
    }

    try {
      let scene = this.sceneManager.startScene();
      this.viteManager.invalidateModule();
      await this.viteManager.loadModule(filePath);

      if (this.previousScenes.has(normalizedFileName)) {
        const previousScene = this.previousScenes.get(normalizedFileName);
        scene = this.sceneManager.compare(previousScene, scene);
      }

      this.previousScenes.set(normalizedFileName, scene);

      this.sceneManager.renderScene(scene);
      const result = scene.getRenderedObjects();

      if (!filePath.startsWith('virtual:live-render')) {
        this.renderingCache.set(normalizedFileName, result);
      }

      return {
        absPath: normalizedFileName,
        result,
        rollbackStop: result.length - 1,
      };
    }
    catch (error) {
      this.viteManager.invalidateModule();
      console.log('Error processing file:', error);
      return null;
    }
  }

  async updateLiveCode(fileName: string, code: string): Promise<SceneRenderedData | null> {
    const id = `virtual:live-render:${fileName}`;
    this.viteManager.setBuffer(id, code);
    this.renderingCache.delete(fileName);
    return this.processFile(id, true);
  }

  async rollback(fileName: string, index: number): Promise<SceneRenderedData | null> {
    if (!this.sceneManager) {
      return null;
    }

    const scene = this.previousScenes.get(fileName);
    if (!scene) {
      return null;
    }

    const totalObjects = scene.getAllSceneObjects().length;

    const rollbackIndex = index >= totalObjects - 1 ? totalObjects - 1 : index;
    this.sceneManager.rollbackScene(scene, rollbackIndex);
    const result = scene.getRenderedObjects();

    return {
      absPath: fileName,
      result,
      rollbackStop: index,
    };
  }

  async importFile(workspacePath: string, fileName: string, data: string): Promise<void> {
    if (!this.sceneManager) {
      throw new Error('SceneManager not initialized');
    }

    const binaryData = Buffer.from(data, 'base64');
    await this.sceneManager.importFile(workspacePath, fileName, binaryData);
  }
}
