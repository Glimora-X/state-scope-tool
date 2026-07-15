/**
 * 解析约定格式的领域 allowlist.ts（Panel 经典脚本版）。
 * 与 src/shared/parse-allowlist-ts.js 保持同步。
 */
(function (global) {
  function extractBalancedObjectLiteral(text, fromIndex) {
    const start = text.indexOf('{', fromIndex);
    if (start < 0) {
      return null;
    }
    let depth = 0;
    let inString = false;
    let quote = '';
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === quote) {
          inString = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  function parseAllowlistTsSource(sourceText) {
    const text = String(sourceText || '').replace(/^\uFEFF/, '');
    const exportMatch = text.match(/export\s+const\s+allowlist\s*=/);
    if (!exportMatch) {
      return {
        ok: false,
        error: '请使用 export const allowlist = { JSON 对象 } 格式，勿含 TS 类型语法'
      };
    }
    const literal = extractBalancedObjectLiteral(text, exportMatch.index + exportMatch[0].length);
    if (!literal) {
      return { ok: false, error: '未能截取 allowlist 对象字面量' };
    }
    let config;
    try {
      config = JSON.parse(literal);
    } catch (error) {
      return {
        ok: false,
        error:
          '对象字面量不是合法 JSON（请用双引号键/字符串，勿含类型注解、as const、展开或函数）：' +
          (error?.message || String(error))
      };
    }
    if (!config?.boName || !Array.isArray(config.fields) || !config.fields.length) {
      return { ok: false, error: 'allowlist 需包含 boName 与非空 fields' };
    }
    return { ok: true, config };
  }

  global.StateScopeParseAllowlistTs = { parseAllowlistTsSource };
})(typeof window !== 'undefined' ? window : globalThis);
