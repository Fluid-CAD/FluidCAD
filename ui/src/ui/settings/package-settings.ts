import type { PackageTarget, UserPreferences } from '../../api';

/**
 * Settings → Packages as applied: the library folder (empty for the
 * default) and where new packages go. The engine acts on both — it resolves
 * the library and picks the install target — so the store exists only to
 * show the stored values to the tab and follow a reset.
 */
export interface PackageSettings {
  libraryPath: string;
  installTarget: PackageTarget;
}

class PackageSettingsStore {
  current: PackageSettings = { libraryPath: '', installTarget: 'library' };

  update(partial: Partial<PackageSettings>): void {
    Object.assign(this.current, partial);
  }
}

export const packageSettings = new PackageSettingsStore();

export function applyPackagePreferences(prefs: UserPreferences): void {
  packageSettings.update({
    libraryPath: typeof prefs.packageLibraryPath === 'string' ? prefs.packageLibraryPath : '',
    installTarget: prefs.packageInstallTarget === 'project' ? 'project' : 'library',
  });
}
