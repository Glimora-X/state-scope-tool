import { LOG_PREFIX } from './activate.js';

/**
 * 不使用 console.group / groupCollapsed。
 * React DevTools installHook 会劫持 console，嵌套 group 在部分环境展开为空白。
 */
const rawLog =
  typeof console !== 'undefined' && typeof console.info === 'function'
    ? console.info.bind(console)
    : () => {};

export function scopeLog(...args) {
  rawLog(LOG_PREFIX, ...args);
}

export function scopeLogBlock(title, lines = []) {
  scopeLog(`── ${title} ──`);
  for (const line of lines) {
    rawLog(`${LOG_PREFIX}   ${line}`);
  }
}
