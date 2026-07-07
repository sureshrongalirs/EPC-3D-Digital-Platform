import type { PanelSlot, ToolbarSlot } from '../plugin';

export function createToolbarSlot(container: HTMLElement): ToolbarSlot {
  const el = document.createElement('div');
  el.className = 'plantscope-toolbar';
  container.appendChild(el);
  const buttons = new Map<string, HTMLButtonElement>();

  return {
    addButton({ id, label, onClick }) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset['plantscopeButtonId'] = id;
      button.addEventListener('click', onClick);
      el.appendChild(button);
      buttons.set(id, button);
    },
    removeButton(id) {
      buttons.get(id)?.remove();
      buttons.delete(id);
    },
  };
}

export function createPanelSlot(container: HTMLElement): PanelSlot {
  const el = document.createElement('div');
  el.className = 'plantscope-panel';
  container.appendChild(el);
  const panels = new Map<string, HTMLElement>();

  return {
    addPanel({ id, title, render }) {
      const panelEl = document.createElement('section');
      panelEl.className = 'plantscope-panel-entry';
      const heading = document.createElement('h3');
      heading.textContent = title;
      const content = document.createElement('div');
      panelEl.append(heading, content);
      el.appendChild(panelEl);
      panels.set(id, panelEl);
      render(content);
    },
    removePanel(id) {
      panels.get(id)?.remove();
      panels.delete(id);
    },
  };
}
