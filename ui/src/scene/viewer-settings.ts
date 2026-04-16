export interface ViewerSettings {
  cameraMode: 'perspective' | 'orthographic';
  showGrid: boolean;
  sectionView: boolean;
}

type Listener = (settings: ViewerSettings) => void;

const defaults: ViewerSettings = {
  cameraMode: 'orthographic',
  showGrid: true,
  sectionView: true,
};

class ViewerSettingsStore {
  current: ViewerSettings = { ...defaults };
  private listeners = new Set<Listener>();

  update(partial: Partial<ViewerSettings>): void {
    Object.assign(this.current, partial);
    for (const fn of this.listeners) fn(this.current);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const viewerSettings = new ViewerSettingsStore();
