import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export function workspaceCwd(workspace, requested = '.', label = 'command cwd') {
  if (isAbsolute(requested)) throw new Error(`${label} must be relative to the implementation workspace`);
  const root = realpathSync(workspace);
  const target = resolve(root, requested);
  const lexical = relative(root, target);
  if (lexical === '..' || lexical.startsWith('../') || !existsSync(target)) throw new Error(`${label} escapes or does not exist in the implementation workspace: ${requested}`);
  const real = realpathSync(target);
  const actual = relative(root, real);
  if (actual === '..' || actual.startsWith('../')) throw new Error(`${label} resolves outside the implementation workspace: ${requested}`);
  return real;
}
