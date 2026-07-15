/**
 * 解析约定格式的领域 allowlist 对象字面量。
 * 支持：
 * - export const allowlist = { ... }
 * - const/var/let allowlist = { ... }（webpack factory 编译结果）
 */

export function extractBalancedObjectLiteral(text, fromIndex) {
  const start = String(text || '').indexOf('{', fromIndex);
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

function tryParseObjectLiteral(literal) {
  try {
    return { ok: true, config: JSON.parse(literal) };
  } catch {
    // webpack 偶发无引号 key；仅接受简单对象字面量
    try {
      // eslint-disable-next-line no-new-func
      const config = Function(`"use strict"; return (${literal});`)();
      if (config && typeof config === 'object') {
        return { ok: true, config };
      }
    } catch {
      // ignore
    }
  }
  return { ok: false, error: '对象字面量解析失败' };
}

function validateAllowlistConfig(config) {
  if (!config?.boName || !Array.isArray(config.fields) || !config.fields.length) {
    return { ok: false, error: 'allowlist 需包含 boName 与非空 fields' };
  }
  return { ok: true, config };
}

/**
 * @param {string} sourceText
 * @returns {{ ok: true, config: object } | { ok: false, error: string }}
 */
export function parseAllowlistObjectFromSource(sourceText) {
  const text = String(sourceText || '').replace(/^\uFEFF/, '');
  if (!/allowlist/i.test(text) || !/"?boName"?\s*:/.test(text)) {
    return { ok: false, error: '源码中未见 allowlist / boName' };
  }

  const patterns = [
    /export\s+const\s+allowlist\s*=/,
    /(?:const|var|let)\s+allowlist\s*=/,
    /exports\.allowlist\s*=/,
    /\ballowlist\s*=/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }
    const literal = extractBalancedObjectLiteral(text, match.index + match[0].length);
    if (!literal) {
      continue;
    }
    const parsed = tryParseObjectLiteral(literal);
    if (!parsed.ok) {
      continue;
    }
    const checked = validateAllowlistConfig(parsed.config);
    if (checked.ok) {
      return checked;
    }
  }

  // 回退：定位 "boName": "<Name>" 向前找最近的 {
  const boNameHit = text.match(/"boName"\s*:\s*"[^"]+"/);
  if (boNameHit && boNameHit.index != null) {
    let start = boNameHit.index;
    while (start > 0 && text[start] !== '{') {
      start -= 1;
    }
    if (text[start] === '{') {
      const literal = extractBalancedObjectLiteral(text, start);
      if (literal) {
        const parsed = tryParseObjectLiteral(literal);
        if (parsed.ok) {
          const checked = validateAllowlistConfig(parsed.config);
          if (checked.ok) {
            return checked;
          }
        }
      }
    }
  }

  return {
    ok: false,
    error: '请使用 export const allowlist = { JSON 对象 } 格式，勿含 TS 类型语法'
  };
}

/**
 * @param {string} sourceText
 * @returns {{ ok: true, config: object } | { ok: false, error: string }}
 */
export function parseAllowlistTsSource(sourceText) {
  const text = String(sourceText || '').replace(/^\uFEFF/, '');
  const exportMatch = text.match(/export\s+const\s+allowlist\s*=/);
  if (!exportMatch) {
    return parseAllowlistObjectFromSource(text);
  }
  const literal = extractBalancedObjectLiteral(text, exportMatch.index + exportMatch[0].length);
  if (!literal) {
    return { ok: false, error: '未能截取 allowlist 对象字面量' };
  }
  const parsed = tryParseObjectLiteral(literal);
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        '对象字面量不是合法 JSON（请用双引号键/字符串，勿含类型注解、as const、展开或函数）'
    };
  }
  return validateAllowlistConfig(parsed.config);
}
