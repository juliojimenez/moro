import { runAll } from './harness';
import './extension.suite';

/** Entry point called by @vscode/test-electron inside the extension host. */
export async function run(): Promise<void> {
  await runAll();
}
