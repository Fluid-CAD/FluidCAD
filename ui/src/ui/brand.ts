/**
 * The FluidCAD logo and wordmark, as the top bar at the left of every FluidCAD
 * page draws them: the product's `TopBar` and the desktop start screen. One
 * builder, so the two bars put the brand in the same place at the same size.
 */
export type Brand = {
  element: HTMLDivElement;
  /** The column under the wordmark, where a bar may add small print (the engine version). */
  wordmarkColumn: HTMLDivElement;
};

export function createBrand(): Brand {
  const element = document.createElement('div');
  element.className = 'flex items-center gap-1.5 shrink-0';
  element.innerHTML = `
      <img src="logo.svg" alt="FluidCAD" class="h-8 w-8 shrink-0" />
      <div class="flex flex-col justify-center">
        <span class="text-[17px] leading-5 font-bold text-base-content/80 tracking-tight">FluidCAD</span>
      </div>
    `;
  return { element, wordmarkColumn: element.querySelector('div')! };
}
