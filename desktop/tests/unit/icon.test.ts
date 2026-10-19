// @vitest-environment happy-dom

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fas } from '@fortawesome/free-solid-svg-icons';
import { describe, expect, it } from 'vitest';
import { createIcon, ICON_IDS, iconMarkup } from '../../src/ui/components/icon';

const spriteSource = readFileSync('assets/crew-ui-symbols.svg', 'utf8');
const sprite = new DOMParser().parseFromString(spriteSource, 'image/svg+xml');
const symbols = [...sprite.querySelectorAll('symbol')];
const symbolIds = new Set(symbols.map((symbol) => symbol.id));

function uiSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? uiSources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('local Font Awesome icons', () => {
  it('provides exactly one symbol for every supported semantic ID', () => {
    expect(symbols).toHaveLength(ICON_IDS.length);
    expect(symbolIds).toEqual(new Set(ICON_IDS));
    for (const id of ICON_IDS) {
      const icon = createIcon(id);
      expect(icon.querySelector('use')?.getAttribute('href')).toBe(`#${id}`);
      expect(icon.querySelector('image')).toBeNull();
      expect(sprite.getElementById(id)?.getAttribute('viewBox')).toBe(icon.getAttribute('viewBox'));
    }
  });

  it('uses official Font Awesome paths, centered within the existing icon sizes', () => {
    const officialPaths = new Set(Object.values(fas).flatMap(({ icon }) =>
      Array.isArray(icon[4]) ? icon[4] : [icon[4]],
    ));
    for (const symbol of symbols) {
      const group = symbol.querySelector('g')!;
      const paths = [...group.querySelectorAll('path')];
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) expect(officialPaths.has(path.getAttribute('d')!)).toBe(true);
      expect(group.getAttribute('stroke')).toBe('none');
      const transform = group.getAttribute('transform')!;
      const numbers = transform.match(/[\d.]+/g)!.map(Number);
      expect(numbers).toHaveLength(3);
      expect(numbers.every((number) => Number.isFinite(number) && number > 0)).toBe(true);
    }
    expect(spriteSource).toContain('CC BY 4.0');
  });

  it('preserves sizing, accessibility, classes and missing-ID diagnostics', () => {
    const icon = createIcon('icon-search', { size: 20, className: 'search-icon', label: '搜索' });
    expect(icon.getAttribute('width')).toBe('20');
    expect(icon.getAttribute('height')).toBe('20');
    expect(icon.classList.contains('search-icon')).toBe(true);
    expect(icon.getAttribute('role')).toBe('img');
    expect(icon.getAttribute('aria-label')).toBe('搜索');
    expect(icon.hasAttribute('aria-hidden')).toBe(false);
    expect(createIcon('icon-search').getAttribute('aria-hidden')).toBe('true');
    const missing = createIcon('not-an-icon');
    expect(missing.dataset.iconMissing).toBe('not-an-icon');
    expect(missing.querySelector('use')?.getAttribute('href')).toBe('#icon-error');
  });

  it('renders equivalent escaped HTML for template callers', () => {
    const options = { size: 18, className: 'test" onclick="bad', label: '<search> "label"' } as const;
    const template = document.createElement('template');
    template.innerHTML = iconMarkup('icon-search', options);
    const icon = template.content.firstElementChild!;
    expect(icon.getAttribute('onclick')).toBeNull();
    expect(icon.getAttribute('aria-label')).toBe(options.label);
    expect(icon.isEqualNode(createIcon('icon-search', options))).toBe(true);
  });

  it('resolves all literal UI sprite references locally, including the static shell', () => {
    const sources = ['assets/index.html', ...uiSources('src/ui')];
    for (const path of sources) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toContain('crew-ui-symbols.svg#');
      for (const match of source.matchAll(/<use href="#([a-z][a-z-]+)"/g)) {
        expect(symbolIds.has(match[1]), `${path}: ${match[1]}`).toBe(true);
      }
    }
    expect(readFileSync('assets/index.html', 'utf8')).not.toMatch(/<(?:path|circle|rect)\b/);
  });

  it('keeps meaningful error, running and completion colors', () => {
    expect(sprite.getElementById('process-error')?.querySelector('g')?.getAttribute('fill'))
      .toBe('var(--mw-status-danger)');
    expect(sprite.getElementById('status-running')?.querySelector('g')?.getAttribute('fill'))
      .toBe('var(--mw-action-primary)');
    expect(sprite.getElementById('status-complete')?.querySelector('g')?.getAttribute('fill'))
      .toBe('var(--mw-status-success)');
  });
});
