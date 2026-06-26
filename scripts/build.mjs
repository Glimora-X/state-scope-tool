import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/injector/index.js'],
  bundle: true,
  outfile: 'dist/injector.js',
  format: 'iife',
  target: ['chrome109'],
  logLevel: 'info'
});

if (watch) {
  await ctx.watch();
  console.log('[StateScope] watching injector...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
