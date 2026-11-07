/**
 * A minimal test runner for the extension host: `node:test` cannot run in
 * process in the Electron Node of older VS Code versions, and the tests need
 * the `vscode` module, so they must run in process.
 */
type TestFunction = () => Promise<void> | void;

interface Registered {
  name: string;
  fn: TestFunction;
  skip: boolean;
}

const tests: Registered[] = [];

export function test(name: string, fn: TestFunction, options: { skip?: boolean } = {}): void {
  tests.push({ name, fn, skip: !!options.skip });
}

/** Polls `check` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor<T>(check: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function runAll(): Promise<void> {
  let failed = 0;
  let skipped = 0;
  for (const entry of tests) {
    if (entry.skip) {
      skipped++;
      console.log(`- ${entry.name} (skipped)`);
      continue;
    }
    const started = Date.now();
    try {
      await entry.fn();
      console.log(`✔ ${entry.name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed++;
      console.error(`✖ ${entry.name}\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  }
  console.log(`\n${tests.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  if (failed) throw new Error(`${failed} extension host test(s) failed`);
}
