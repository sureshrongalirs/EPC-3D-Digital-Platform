import { getCorePlaceholder } from '@plantscope/core';

const app = document.querySelector<HTMLDivElement>('#app');

if (app) {
  app.textContent = `PlantScope demo — ${getCorePlaceholder()}`;
}
