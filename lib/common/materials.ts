export type Material = { name: string; density: number; densityUnit: string };

export const MATERIALS: Material[] = [
  { name: 'Steel (AISI 1020)',       density: 7.87, densityUnit: 'g/cm³' },
  { name: 'Stainless Steel (304)',   density: 8.00, densityUnit: 'g/cm³' },
  { name: 'Aluminum 6061',           density: 2.70, densityUnit: 'g/cm³' },
  { name: 'Aluminum 1060',           density: 2.81, densityUnit: 'g/cm³' },
  { name: 'Aluminum 7075',           density: 2.81, densityUnit: 'g/cm³' },
  { name: 'Brass (C260)',            density: 8.53, densityUnit: 'g/cm³' },
  { name: 'Copper',                  density: 8.96, densityUnit: 'g/cm³' },
  { name: 'Titanium Ti-6Al-4V',     density: 4.43, densityUnit: 'g/cm³' },
  { name: 'Cast Iron (Gray)',        density: 7.15, densityUnit: 'g/cm³' },
  { name: 'Bronze',                  density: 8.73, densityUnit: 'g/cm³' },
  { name: 'Polycarbonate (PC)',      density: 1.20, densityUnit: 'g/cm³' },
  { name: 'ABS Plastic',            density: 1.05, densityUnit: 'g/cm³' },
  { name: 'PLA',                     density: 1.24, densityUnit: 'g/cm³' },
  { name: 'Nylon (PA6)',             density: 1.14, densityUnit: 'g/cm³' },
  { name: 'Carbon Fiber Composite', density: 1.55, densityUnit: 'g/cm³' },
  { name: 'Wood (Pine)',             density: 0.53, densityUnit: 'g/cm³' },
  { name: 'Plain Carbon Steel',      density: 0.098, densityUnit: 'lbs/in³' },
];

export function getMaterials(): Material[] {
  return MATERIALS;
}
