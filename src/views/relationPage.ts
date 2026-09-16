import { t } from '../i18n';

/** Markup of the Relations webview; vscode-free so previews and tests can render it. */
export function relationPageHtml(n: string, cspSource: string, script: string, codicons: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; script-src 'nonce-${n}' ${cspSource};">
<link rel="stylesheet" href="${codicons}">
<style>
  html, body { height: 100%; margin: 0; overflow: hidden; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  #bar { display: flex; gap: 6px; align-items: center; padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); white-space: nowrap; overflow: hidden; }
  #bar select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); padding: 1px 2px; font-size: 11px; max-width: 42%; }
  #bar button { background: none; border: 1px solid transparent; color: inherit; cursor: pointer; padding: 1px 4px; border-radius: 3px; display: inline-flex; align-items: center; gap: 2px; font-size: 11px; opacity: .85; }
  #bar button:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  #bar button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; }
  #bar label { display: flex; align-items: center; gap: 2px; font-size: 11px; opacity: .85; }
  #title { font-size: 11px; opacity: .8; padding: 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
  #title b { font-weight: 600; opacity: 1; }
  #cy { position: absolute; top: 48px; bottom: 0; left: 0; right: 0; }
  #list { position: absolute; top: 48px; bottom: 0; left: 0; right: 0; overflow: auto; padding: 4px 6px; display: none; font-size: 12px; }
  #list ul { list-style: none; margin: 0; padding-left: 14px; }
  #list > ul { padding-left: 2px; }
  #list li { padding: 1px 0; white-space: nowrap; }
  #list .n { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; padding: 1px 4px; border-radius: 3px; }
  #list .n:hover { background: var(--vscode-list-hoverBackground); }
  #list .n.center { font-weight: 600; }
  #list .n .f { opacity: .55; font-size: 11px; }
  #list .n .cnt { opacity: .6; font-size: 10px; }
  #list .tw { width: 14px; display: inline-flex; justify-content: center; cursor: pointer; opacity: .7; }
  #list .grp { opacity: .8; font-style: italic; }
  #empty { position: absolute; top: 45%; width: 100%; text-align: center; opacity: .6; padding: 0 12px; box-sizing: border-box; }
  #note { position: absolute; right: 8px; bottom: 6px; font-size: 10px; opacity: .6; }
  .hint { font-size: 10px; opacity: .55; white-space: nowrap; margin-left: auto; }
</style></head><body>
<div id="bar">
  <select id="mode" title="${t('modeSymbol')} / ${t('modeClass')} / ${t('modeFile')}">
    <optgroup label="${t('modeSymbol')}">
      <option value="callees">${t('calls')}</option>
      <option value="callers">${t('callers')}</option>
      <option value="both">${t('both')}</option>
    </optgroup>
    <optgroup label="${t('modeClass')}">
      <option value="bases">${t('bases')}</option>
      <option value="derived">${t('derived')}</option>
      <option value="classBoth">${t('both')}</option>
    </optgroup>
    <optgroup label="${t('modeFile')}">
      <option value="includes">${t('includes')}</option>
      <option value="includedBy">${t('includedBy')}</option>
      <option value="includesBoth">${t('both')}</option>
    </optgroup>
  </select>
  <label title="${t('depth')}"><i class="codicon codicon-layers"></i><select id="depth"><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
  <button id="viewGraph" class="on" title="${t('viewGraph')}"><i class="codicon codicon-type-hierarchy-sub"></i></button>
  <button id="viewList" title="${t('viewList')}"><i class="codicon codicon-list-tree"></i></button>
  <button id="follow" title="${t('followCursor')}"><i class="codicon codicon-pinned"></i></button>
  <button id="fit" title="${t('fitTitle')}"><i class="codicon codicon-screen-full"></i></button>
  <span class="hint">${t('graphHint')}</span>
</div>
<div id="title"></div>
<div id="cy"></div>
<div id="list"></div>
<div id="empty">${t('relationsEmpty')}</div>
<div id="note"></div>
<script nonce="${n}" src="${script}"></script>
</body></html>`;
}
