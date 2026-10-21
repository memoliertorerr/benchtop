/** Palette groups, in display order. Every `PartDefinition.category` is one of these ids. */
export const PART_CATEGORIES = [
  { id: 'boards', title: 'Boards' },
  { id: 'breadboards', title: 'Breadboards' },
  { id: 'basic', title: 'Basic' },
  { id: 'input', title: 'Input' },
  { id: 'output', title: 'Output' },
  { id: 'displays', title: 'Displays' },
  { id: 'sensors', title: 'Sensors' },
  { id: 'motors', title: 'Motors' },
  { id: 'power', title: 'Power' },
  { id: 'environment', title: 'Environment' },
] as const;

export type PartCategoryId = (typeof PART_CATEGORIES)[number]['id'];

/** Converts @wokwi/elements pin coordinates (CSS px at 96 dpi) to mm. */
export const MM_PER_PX = 25.4 / 96;
