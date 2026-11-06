// Bundles the extension client and the language server into dist/.
//   node esbuild.mjs               one-off development build (with source maps)
//   node esbuild.mjs --watch       rebuild on change
//   node esbuild.mjs --production  minified build used by `vsce package`
import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: production ? false : 'linked',
  sourcesContent: false,
  minify: production,
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['src/client/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/server/main.ts'], outfile: 'dist/server.js' },
];

const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[watch] build finished, watching for changes...');
} else {
  try {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}
