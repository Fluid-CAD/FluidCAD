export type Material = { name: string; density: number }; // density in g/cm³

export const MATERIALS: Material[] = [
  { name: 'Steel (AISI 1020)', density: 7.87 },
  { name: 'Stainless Steel (304)', density: 8.00 },
  { name: 'Aluminum 6061', density: 2.70 },
  { name: 'Aluminum 1060', density: 2.81 },
  { name: 'Aluminum 7075', density: 2.81 },
  { name: 'Brass (C260)', density: 8.53 },
  { name: 'Copper', density: 8.96 },
  { name: 'Titanium Ti-6Al-4V', density: 4.43 },
  { name: 'Cast Iron (Gray)', density: 7.15 },
  { name: 'Bronze', density: 8.73 },
  { name: 'Polycarbonate (PC)', density: 1.20 },
  { name: 'ABS Plastic', density: 1.05 },
  { name: 'PLA', density: 1.24 },
  { name: 'Nylon (PA6)', density: 1.14 },
  { name: 'Carbon Fiber Composite', density: 1.55 },
  { name: 'Wood (Pine)', density: 0.53 },
  { name: 'Plain Carbon Steel', density: 0.78 },
];

export function getMaterials(): Material[] {
  return MATERIALS;
}
