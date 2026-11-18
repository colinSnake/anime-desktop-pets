import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workspace = 'apps/workspace-ui/src';
const startup = 'apps/desktop/startup';
const native = 'apps/desktop/src';
const colorProperty = /^(?:color|[\w-]+-color|background(?:-image)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|outline|(?:text|box)-shadow|fill|stroke|(?:backdrop-)?filter|text-decoration)$/i;
const literalColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|(?:ok)?lab|(?:ok)?lch|color|device-cmyk|light-dark)\(/i;
// These words control syntax or inherit a computed color; none selects a palette color.
const colorSyntax = new Set('auto none inherit initial unset revert revert-layer currentcolor solid dashed dotted double inset underline important padding-box border-box linear-gradient radial-gradient to left right top bottom color-mix in srgb blur'.split(' '));
const ref = /var\(\s*(--[\w-]+)/g;

async function sources(directory: string, extension: RegExp) {
  const entries = await readdir(join(root, directory), { recursive: true });
  return Promise.all(entries.filter(name => extension.test(name)).sort().map(async name => {
    const path = `${directory}/${name.replaceAll('\\', '/')}`;
    return { path, source: await readFile(join(root, path), 'utf8') };
  }));
}

test('workspace and startup components consume defined theme tokens instead of raw colors', async () => {
  const findings: string[] = [];
  for (const directory of [workspace, startup]) {
    const sheets = await sources(directory, /\.css$/);
    const declared = new Set(sheets.flatMap(({ source }) => [...source.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1])));
    for (const { path, source } of sheets) {
      const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, name] of css.matchAll(ref)) if (!declared.has(name!)) findings.push(`${path}: undefined ${name}`);
      for (const [, property = '', value = ''] of css.matchAll(/(?:^|[;{}])\s*([\w-]+)\s*:\s*([^;{}]+)/g)) {
        if ((path === `${workspace}/theme.css` && property.startsWith('--')) ||
            (path === `${startup}/player.css` && property.startsWith('--startup-'))) continue;
        const unwrapped = value.replace(/var\(\s*--[\w-]+\s*\)/g, '');
        const words = unwrapped.match(/(?<![\w#%-])[a-z][\w-]*/gi) ?? [];
        if (literalColor.test(unwrapped) || (colorProperty.test(property) && words.some(word => !colorSyntax.has(word.toLowerCase()))))
          findings.push(`${path}: ${property}: ${value.trim()}`);
      }
    }
  }
  assert.deepEqual(findings, []);
});

test('native window colors go through named theme values and UI icons can inherit their ink', async () => {
  const findings: string[] = [];
  for (const { path, source } of await sources(native, /\.ts$/)) {
    for (const [, value] of source.matchAll(/\bbackgroundColor:\s*([^,\n]+)/g)) {
      if (!/^windowColors\.[\w]+$/.test(value!.trim())) findings.push(`${path}: backgroundColor: ${value}`);
    }
  }
  for (const { path, source } of await sources(workspace, /\.[jt]sx$/)) {
    for (const [, name, value] of source.matchAll(/\b(fill|stroke|color)=["']([^"']+)["']/g)) {
      if (!/^(?:currentColor|none|var\(--[\w-]+\))$/.test(value!)) findings.push(`${path}: ${name}=${value}`);
    }
  }
  assert.deepEqual(findings, []);
});
