/** A section's caption on the start screen ("Recent projects", "Learn FluidCAD"). */
export function sectionHeading(text: string): HTMLHeadingElement {
  const heading = document.createElement('h2');
  heading.className = 'text-xs uppercase tracking-wider font-medium text-base-content/60 mb-3';
  heading.textContent = text;
  return heading;
}
