# StateScope

单据状态 **L2 shadow** 透视 Chrome 扩展（**P0：仅 Console diff**）。

仓库：[github.com/Glimora-X/state-scope-tool](https://github.com/Glimora-X/state-scope-tool)

- **不绑定单据**：运行时通过 `window.bizApplication.boName` 识别当前 BO
- **Profile 分线**：`traditional`（StateCollector）/ `lowcode`（getDisable），默认 `auto`
- **零生产影响**：仅 `bizDebug=true` 且存在 `bizApplication.stateManager` 时激活

设计文档：`Obsidian Vault/单据知识库/chanjet-mdf-biz-service/StateScope-状态透视工具设计方案.md`

## 前置条件

1. 页面开启调试：

```javascript
localStorage.setItem('bizDebug', 'true');
// 刷新页面（需在 createBizApplication 之前设置，bizApplication 才会挂到 window）
```

2. 打开已接入 `stateManager` 的单据页（如销货单）

## 安装

```bash
cd /Users/juanwang/Documents/work-space/owner/state-scope-tool
yarn install
yarn build
```

Chrome → `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择本目录。

## 使用

1. 打开单据页，DevTools Console 过滤 `[StateScope]`
2. 操作字段（改表头、改明细行），每个 epoch 结束后输出 diff：

```text
[StateScope] Epoch #3 | GoodsIssue | traditional | incremental | 1 mismatch(es) / 4 key(s)
  ❌ goodsItems.xxx.warehouseId.disabled | old=true new=false | logic-mismatch
```

3. 手动设置 allowlist（可选，P0 默认 diff 全部捕获字段）：

```javascript
__StateScope__.setAllowlist('GoodsIssue', ['main.exchangeRate', 'goodsItems.{uuid}.warehouseId']);
```

## 排障

**Console 没有任何 `[StateScope]` 输出：**

1. 确认扩展已加载：`chrome://extensions` 中 StateScope 已启用，修改代码后点刷新
2. **先设 bizDebug 再刷新页面**（顺序不能反）：

```javascript
localStorage.setItem('bizDebug', 'true');
location.reload();
```

3. `bizDebug` 不是全局变量也正常，看 `localStorage.getItem('bizDebug') === 'true'` 即可
4.  Console 过滤框填 `StateScope`（会匹配 `[StateScope]` 前缀）
5. 页面加载后应至少看到：`[StateScope] injector loaded`

**只有 injector loaded，没有 active：**

```javascript
// 手动诊断
__StateScope__?.getDiagnostics?.()
// 或页面尚未挂载 presenter 时，等几秒后：
__StateScope__?.rediscover?.()
```

| 现象 | 原因 |
|------|------|
| `stateManager: false` | 销货单未开**升级模式**，`window.bizApplication` 不存在；旧链路仍可通过 FormController 观测 |
| `formController/uiStateController: false` | 单据页尚未渲染完；刷新扩展后重载页面，或执行 `__StateScope__.rediscover()` |
| `profile=lowcode` 但实际是销货单 | 旧版误判；v0.1.2+ 已优先 traditional，请刷新扩展 |
| 有 active 但无 diff | 新规则未注册时仅有 old 轨；操作改字段触发 `refreshView` 后才会出 epoch |

**升级模式（新链路 statePatches 必需）：**

```javascript
// 销货单升级模式 localStorage 示例
const list = JSON.parse(localStorage.getItem('upgrade_voucher_list') || '{}');
list.web_GoodsIssue = true;
localStorage.setItem('upgrade_voucher_list', JSON.stringify(list));
location.reload();
```

刷新扩展后，每次 `refreshView` 会输出一个可折叠分组，内含：

```text
[StateScope] scope: changedFields.main=3 → checkMainFieldState 重算 87 个表头字段 | 明细变更行 2 [goodsItems(+0/~2/-0)]
[StateScope] 变更集字段终态 (3 条)
  main.exchangeRate.disabled = false (enabled/可编辑)
[StateScope] 表头全量终态 (87 条)   ← 仅当重算范围 > 变更集时展开
```

- **scope 行**：变更集 vs 实际重算范围
- **终态**：每个字段 `disabled=true/false` 的最终结果（不是函数调用次数）

## 配置

| key | 值 | 说明 |
|-----|-----|------|
| `localStorage.bizDebug` | `'true'` | 必须，与产品 debugUtils 一致 |
| `localStorage.stateScopeProfile` | `auto` / `traditional` / `lowcode` | 强制 runtime profile |
| `localStorage.stateScopeVerbose` | `'true'` | 打印完整 oldSnap/newSnap（默认仅摘要） |
| `localStorage.stateScopeDebug` | `'true'` | 每轮 epoch 写入 `__StateScope__.getLastEpoch()`，并提示 diagnose API |

## 调试（Console 展开空白时）

P0 **不使用** `console.groupCollapsed`，每行独立 `console.info`，不依赖折叠展开。

若仍看不到明细，在 Console 执行：

```javascript
localStorage.setItem('stateScopeDebug', 'true');
location.reload();
// 操作单据后：
__StateScope__.diagnoseLastEpoch()   // key 交集统计 + 样本 key
__StateScope__.getLastEpoch()        // 完整 changedSample / finalSnap 对象
__StateScope__.dumpLastEpoch()       // JSON 字符串，可复制给我
```

## P0 能力边界

| 能力 | 状态 |
|------|------|
| Wrap `dispatchAction` → `statePatches` | ✅ |
| Wrap `computeInitialStates` | ✅（若 stateManager 暴露该方法） |
| Wrap `UiStateController` 旧链路 | ✅（自动发现） |
| Wrap `getDisable`（lowcode） | ✅（自动发现 viewModel） |
| DevTools Panel | ❌ P3 |
| 切流报告 / 快照导出 | ❌ P3/P4 |
| `FormController.applyStatePatches` B4 检测 | ❌ P2（等平台方法合入） |

## 目录结构

```text
state-scope-tool/
  manifest.json
  src/
    content/bridge.js       # 注入 MAIN world
    injector/               # 观测与 diff 逻辑
    background/             # P0 占位
  dist/injector.js          # yarn build 产出
  allowlists/               # 示例配置（按 boName）
```

## 开发

```bash
yarn watch   # 监听 injector 变更，改完后在 chrome://extensions 点刷新
```
