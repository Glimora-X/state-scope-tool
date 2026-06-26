import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome109'],
  logLevel: 'info'
};

const ctx = await esbuild.context({
  ...common,
  entryPoints: ['src/injector/index.js'],
  outfile: 'dist/injector.js'
});

const swCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/background/service-worker.js'],
  outfile: 'dist/service-worker.js',
  format: 'esm'
});

if (watch) {
  await ctx.watch();
  await swCtx.watch();
  console.log('[StateScope] watching injector + service-worker...');
} else {
  await ctx.rebuild();
  await swCtx.rebuild();
  await ctx.dispose();
  await swCtx.dispose();
}
