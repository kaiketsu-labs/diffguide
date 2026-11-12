import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';

type Layer = 'core' | 'page' | 'hosts' | 'forges' | 'agents';

/** Layers each layer must not import; `vscode` stands for the VS Code API. */
const forbidden: Record<Layer, readonly (Layer | 'vscode')[]> = {
  core: ['vscode', 'page', 'hosts', 'forges', 'agents'],
  page: ['vscode', 'hosts', 'forges', 'agents'],
  forges: ['vscode', 'hosts', 'page', 'agents'],
  agents: ['vscode', 'hosts', 'page', 'forges'],
  hosts: [],
};

const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
const layerOf = (file: string): Layer => relative('src', file).split('/')[0] as Layer;

test('each layer imports only the layers it may depend on', () => {
  const violations: string[] = [];
  for (const file of sourceFiles('src')) {
    const layer = layerOf(file);
    const text = readFileSync(file, 'utf8');
    for (const [, specifier = ''] of text.matchAll(/(?:from|import\()\s*'([^']+)'/g)) {
      const target = specifier === 'vscode' ? 'vscode' : specifier.startsWith('.') ? layerOf(resolve(dirname(file), specifier)) : undefined;
      if (target !== undefined && forbidden[layer].includes(target as Layer | 'vscode')) violations.push(`${relative('src', file)} imports ${specifier}`);
    }
  }
  assert.deepEqual(violations, []);
});
