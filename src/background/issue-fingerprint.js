export function normalizeFieldPath(path) {
  return String(path || '')
    .replace(/\.(visible|disabled)$/, '')
    .replace(/goodsItems\.[^.]+/g, 'goodsItems.{uuid}');
}

export function inferStateType(path) {
  if (String(path).endsWith('.visible')) {
    return 'visible';
  }
  return 'disabled';
}

export function buildIssueFingerprint({ boName, fieldPath, stateType, scenarioTag, issueType }) {
  return [
    boName || 'unknown',
    normalizeFieldPath(fieldPath),
    stateType || inferStateType(fieldPath),
    scenarioTag || 'unknown',
    issueType || 'logic-mismatch'
  ].join('::');
}

export function buildIssueTitle({ boName, fieldPath, stateType, scenarioTag, issueType }) {
  const path = normalizeFieldPath(fieldPath);
  return `[${boName}][${scenarioTag}] ${path}.${stateType || inferStateType(fieldPath)} · ${issueType}`;
}
