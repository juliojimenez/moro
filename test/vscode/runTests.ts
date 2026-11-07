/**
 * Launches VS Code with the extension under development and runs the suite in
 * test/vscode/suite inside its extension host. Usage: npm run test:vscode
 * (downloads VS Code into .vscode-test on first run; on Linux CI wrap it in xvfb-run).
 */
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', '..');
  const fixture = path.join(root, 'test', 'vscode', 'fixture');
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index'),
      launchArgs: [fixture, '--disable-extensions', '--disable-workspace-trust', '--disable-gpu', '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: { MORO_FIXTURE: fixture },
    });
  } catch (error) {
    console.error('Extension host tests failed:', error);
    process.exit(1);
  }
}

void main();
