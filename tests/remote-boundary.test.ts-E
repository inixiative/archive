import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const sourceDirectory = resolve(import.meta.dir, '../src');

const relativeImports = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)].map(([, path]) =>
    join(dirname(file), `${path}.ts`),
  );

const reachableFrom = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...relativeImports(file));
  }
  return seen;
};

test('the remote client never reaches the database, even through type-only imports', () => {
  const reachable = [...reachableFrom(join(sourceDirectory, 'remote.ts'))].map((file) =>
    file.slice(sourceDirectory.length + 1),
  );
  expect(reachable).not.toContain('store.ts');
  expect(reachable).not.toContain('client.ts');
  for (const file of reachable)
    expect(readFileSync(join(sourceDirectory, file), 'utf8')).not.toContain('@prisma/client');
});
