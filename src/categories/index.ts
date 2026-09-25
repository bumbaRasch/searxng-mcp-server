/** Category registry public surface: one definition per search tool (D1). */
export * from './types.js';
export * from './shared.js';
export * from './general.js';
export * from './images.js';
export * from './news.js';
export * from './videos.js';
export * from './music.js';
export * from './paper.js';

import { generalCategory } from './general.js';
import { imageCategory } from './images.js';
import { musicCategory } from './music.js';
import { newsCategory } from './news.js';
import { paperCategory } from './paper.js';
import { videoCategory } from './videos.js';

/** Registration order of the registry defines the category tool order. */
export const categoryDefinitions = [
  generalCategory,
  imageCategory,
  newsCategory,
  videoCategory,
  musicCategory,
  paperCategory,
];
