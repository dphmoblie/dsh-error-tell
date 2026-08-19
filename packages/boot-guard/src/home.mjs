import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const MANAGED_START = '# --- dsh-error-tell managed (auto-generated; do not edit) ---';
export const MANAGED_END = '# --- end dsh-error-tell managed ---';

export function dshHome(env = process.env) {
  return resolve(env.DSH_HOME || join(homedir(), '.dsh'));
}
export function homePatchPath(home) {
  return join(home, 'cordis.patch.yml');
}
export function stateDir(home) {
  return join(home, 'state', 'dsh-error-tell');
}
export function quarantinePath(home) {
  return join(stateDir(home), 'quarantine.json');
}
