import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rendererDir = fileURLToPath(new URL('../../', import.meta.url));
const themeCssPath = join(rendererDir, 'theme.css');

const readThemeCss = (): string => readFileSync(themeCssPath, 'utf8');

const definedTokens = (css: string): Set<string> =>
  new Set(Array.from(css.matchAll(/(--pi-[a-z0-9-]+)\s*:/g), (match) => match[1]));

const usedTokens = (css: string): Set<string> =>
  new Set(Array.from(css.matchAll(/var\((--pi-[a-z0-9-]+)/g), (match) => match[1]));

const cssModules = readdirSync(rendererDir, { recursive: true, encoding: 'utf8' })
  .filter((entry) => entry.endsWith('.css') && entry !== 'theme.css')
  .map((entry) => join(rendererDir, entry));

const themeCss = readThemeCss();

describe('theme.css tokens', () => {
  it('keeps the original dark palette as the default', () => {
    expect(themeCss).toMatch(/--pi-bg-app:\s*#161a1f/);
    expect(themeCss).toMatch(/--pi-bg-panel:\s*#1e2329/);
    expect(themeCss).toMatch(/--pi-bg-control:\s*#2a3139/);
    expect(themeCss).toMatch(/--pi-border:\s*#353b43/);
    expect(themeCss).toMatch(/--pi-text:\s*#d7dce2/);
    expect(themeCss).toMatch(/--pi-accent:\s*#5b9cff/);
  });

  it('defines an islands override for the shell tokens', () => {
    expect(themeCss).toMatch(/html\[data-theme='islands'\]/);
    expect(themeCss).toMatch(/--pi-island-gap:\s*10px/);
    expect(themeCss).toMatch(/--pi-island-padding:\s*10px/);
    expect(themeCss).toMatch(/--pi-island-border-width:\s*1px/);
    expect(themeCss).toMatch(/--pi-island-shadow:\s*0 8px 24px/);
  });

  it('has no undefined variables in any renderer CSS module', () => {
    const defined = definedTokens(themeCss);
    const missing = new Set<string>();

    for (const file of cssModules) {
      for (const token of usedTokens(readFileSync(file, 'utf8'))) {
        if (!defined.has(token)) missing.add(`${token} (${file})`);
      }
    }

    expect(Array.from(missing)).toEqual([]);
  });

  it('opts every major surface into the island chrome', () => {
    const majors = [
      'App.module.css',
      'components/Toolbar/Toolbar.module.css',
      'components/Workspace/DocumentTabs.module.css',
      'components/LeftPanel/LeftPanel.module.css',
      'components/InspectorPanel/InspectorPanel.module.css',
      'components/StatusBar/StatusBar.module.css',
      'components/Diff/DiffWorkspace.module.css',
      'components/Audit/AuditWorkspace.module.css',
      'components/Raw/RawWorkspace.module.css',
    ];

    for (const relative of majors) {
      const css = readFileSync(join(rendererDir, relative), 'utf8');
      expect(css, relative).toContain("html[data-theme='islands']");
      expect(css, relative).toContain('--pi-island-');
    }
  });
});
