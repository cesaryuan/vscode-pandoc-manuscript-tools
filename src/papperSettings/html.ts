import { buildCslPickerHtml } from "../inlayHints/csl/pickerHtml";
import { SETTINGS_SECTIONS } from "./model";

/** Builds one settings window with shared navigation, field editors and the embedded Zotero bibliography section. */
export function buildPapperSettingsHtml(): string {
  const navigation = SETTINGS_SECTIONS.map((section) => `<button class="nav-item" data-section="${section.id}">${section.title}</button>`).join("");
  return buildCslPickerHtml({
    styles: `
    [hidden] { display:none !important; }
    .settings-head { padding:20px 24px 14px; border-bottom:1px solid var(--vscode-panel-border); }
    .settings-head h1 { margin:0 0 8px; font-size:22px; } #source { overflow-wrap:anywhere; margin-bottom:12px; }
    .settings-tools { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    select,textarea { font:inherit; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border,transparent); padding:8px; border-radius:3px; }
    .settings-layout { display:grid; grid-template-columns:190px minmax(0,1fr); height:calc(100vh - 155px); }
    nav { padding:16px 10px; border-right:1px solid var(--vscode-panel-border); overflow:auto; }
    .nav-item { display:block; width:100%; text-align:left; background:transparent; color:var(--vscode-foreground); padding:12px; margin-bottom:4px; }
    .nav-item[aria-current="page"] { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
    .settings-main { min-width:0; min-height:0; } .page { height:100%; padding:20px; gap:14px; }
    #field-page { height:100%; overflow:auto; padding:22px 28px; }
    #field-page h2 { margin:0 0 10px; font-size:20px; } #section-help { margin-bottom:20px; }
    .setting { padding:16px 0; border-bottom:1px solid var(--vscode-panel-border); }
    .setting label { display:block; font-size:14px; font-weight:600; margin-bottom:6px; }
    .setting-path { font-size:12px; opacity:.65; overflow-wrap:anywhere; margin-bottom:8px; }
    .setting-controls { display:flex; gap:8px; align-items:flex-start; flex-wrap:wrap; }
    .setting-controls input,.setting-controls select,.setting-controls textarea { flex:1; min-width:130px; max-width:520px; }
    .setting-controls textarea { min-height:74px; } .setting-status { margin-top:7px; overflow-wrap:anywhere; }
    #style-picker { display:flex; align-items:center; gap:10px; margin:18px 0; } #style-name { max-width:380px; }
    #message { min-height:20px; margin-top:10px; } .error { color:var(--vscode-errorForeground); }
    #csl-config { max-height:215px; overflow:auto; flex-shrink:0; } #csl-config .setting { padding:6px 0 10px; }
    #csl-config summary { cursor:pointer; padding:8px 0; color:var(--vscode-descriptionForeground); }
    #bibliography .content { gap:16px; grid-template-columns:minmax(180px,32%) minmax(0,1fr); }
    #bibliography h1 { font-size:20px; }
    @media(max-width:780px) { .settings-layout { grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); } nav { display:flex; padding:8px; border-right:0; border-bottom:1px solid var(--vscode-panel-border); overflow-x:auto; } .nav-item { white-space:nowrap; width:auto; margin:0; } #field-page { padding:18px; } .settings-head { padding:14px; } }
    @media(max-width:650px) { #bibliography .content { grid-template-columns:1fr; } #csl-config { max-height:155px; } }
    `,
    before: `<header class="settings-head"><h1>Papper 设置</h1><div id="source" class="muted">正在读取配置…</div>
      <div class="settings-tools"><label for="scope">设置范围</label><select id="scope"><option value="main">当前稿件 / 项目</option><option value="reply">审稿回复覆盖</option></select>
      <button id="refresh" class="secondary">刷新配置</button><button id="open-source" class="secondary">查看源配置</button></div>
      <div id="message" role="status" aria-live="polite"></div></header>
      <div class="settings-layout"><nav aria-label="Papper 设置分区">${navigation}</nav><div class="settings-main">
      <main id="field-page"><h2 id="section-title"></h2><p id="section-help" class="muted">应用后写入源配置，可撤销；保存源文档后用于下次构建</p>
      <div id="style-picker" hidden><label for="style-name">Word 样式名称</label><input id="style-name" list="style-names" value="Body Text" aria-label="Word 样式名称"><datalist id="style-names"></datalist><button id="choose-style">编辑此样式</button></div>
      <div id="fields"></div></main>`,
    after: `</div></div>`,
    script: `
    (() => {
      const scopeControl = document.getElementById('scope');
      const fieldPage = document.getElementById('field-page');
      const bibliography = document.getElementById('bibliography');
      const messageNode = document.getElementById('message');
      const drafts = new Map();
      let state;
      let section = 'math';
      /** Reports a setting operation without replacing a field's unsaved input. */
      function status(text, error = false) { messageNode.textContent = text; messageNode.className = error ? 'error' : 'muted'; }
      /** Navigates within the same page; Zotero is loaded only when its section is visited. */
      function navigate(id) {
        section = id;
        bibliography.hidden = id !== 'bibliography'; fieldPage.hidden = id === 'bibliography';
        for (const button of document.querySelectorAll('[data-section]')) button.setAttribute('aria-current', button.dataset.section === id ? 'page' : 'false');
        document.getElementById('style-picker').hidden = id !== 'docx';
      }
      /** Requests source values for a section, preserving the selected Word style. */
      function requestView(id = section) {
        navigate(id);
        vscode.postMessage({type:'settingsView', section:id, scope:scopeControl.value, styleName:document.getElementById('style-name').value});
        if (id === 'bibliography') { vscode.postMessage({type:'ready'}); search.focus(); }
      }
      /** Renders an individual setting with explicit apply/reset actions and separately labeled inheritance. */
      function settingRow(row) {
        const container = document.createElement('div'); container.className = 'setting';
        const key = JSON.stringify(row.path);
        const label = document.createElement('label'); label.textContent = row.description;
        const inputId = 'setting-' + row.path.map(encodeURIComponent).join('-'); label.htmlFor = inputId;
        const path = document.createElement('div'); path.className = 'setting-path'; path.textContent = row.path.join(' › ');
        const controls = document.createElement('div'); controls.className = 'setting-controls';
        const input = document.createElement(row.kind === 'boolean' ? 'select' : row.kind === 'yaml' ? 'textarea' : 'input'); input.id = inputId; input.setAttribute('aria-label', row.description);
        if (row.kind === 'boolean') { for (const [value, title] of [['','继承 / 默认'],['true','开启'],['false','关闭']]) { const option = document.createElement('option'); option.value = value; option.textContent = title; input.append(option); } }
        else if (row.options?.length && row.kind === 'text') { const options = document.createElement('datalist'); options.id = inputId + '-options'; for (const value of row.options) { const option = document.createElement('option'); option.value = value; options.append(option); } input.setAttribute('list', options.id); container.append(options); }
        input.value = drafts.has(key) ? drafts.get(key) : row.value;
        input.addEventListener('input', () => drafts.set(key,input.value));
        if (!row.configured && input.tagName !== 'SELECT') input.placeholder = row.inherited ?? '未设置，使用继承或默认值';
        const save = document.createElement('button'); save.textContent = '应用';
        const reset = document.createElement('button'); reset.className = 'secondary'; reset.textContent = '恢复继承'; reset.disabled = !row.configured;
        /** Submits one source edit against the displayed configuration snapshot. */
        function applySetting(resetValue) {
          if (!state) return;
          if (!resetValue && row.kind === 'boolean' && input.value === '') { status('请选择开启或关闭，或使用恢复继承',true); return; }
          vscode.postMessage({type:'settingsSave', path:row.path, input:input.value, reset:resetValue, original:state.content});
        }
        save.addEventListener('click', () => applySetting(false)); reset.addEventListener('click', () => applySetting(true));
        const note = document.createElement('div'); note.className = 'setting-status muted'; note.textContent = row.configured ? '已在当前范围设置' : row.inherited !== undefined ? '继承项目设置：' + row.inherited : '未显式设置，使用 Papper 默认或其他继承配置';
        controls.append(input,save,reset); container.append(label,path,controls,note); return container;
      }
      for (const button of document.querySelectorAll('[data-section]')) button.addEventListener('click', () => requestView(button.dataset.section));
      scopeControl.addEventListener('change', () => { drafts.clear(); requestView(); });
      document.getElementById('refresh').addEventListener('click', () => { drafts.clear(); requestView(); });
      document.getElementById('open-source').addEventListener('click', () => vscode.postMessage({type:'settingsSource'}));
      document.getElementById('choose-style').addEventListener('click', () => requestView('docx'));
      window.addEventListener('message', event => {
        const data = event.data;
        if (data.type === 'settingsState') {
          if (state && state.uri !== data.uri) drafts.clear();
          state = data; scopeControl.value = data.scope; navigate(data.section);
          document.getElementById('source').textContent = data.sourceLabel;
          document.getElementById('section-title').textContent = data.title;
          document.getElementById('style-name').value = data.styleName;
          const names = data.styleNames.map(name => { const option = document.createElement('option'); option.value = name; return option; });
          document.getElementById('style-names').replaceChildren(...names);
          const target = data.section === 'bibliography' ? document.getElementById('csl-config') : document.getElementById('fields');
          if (data.section === 'bibliography') {
            const csl = data.rows.find(row => row.title === 'csl');
            const more = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '更多参考文献设置';
            more.append(summary,...data.rows.filter(row => row !== csl).map(settingRow)); target.replaceChildren(settingRow(csl),more);
          } else target.replaceChildren(...data.rows.map(settingRow));
          if (data.section === 'bibliography') { vscode.postMessage({type:'ready'}); search.focus(); }
        } else if (data.type === 'settingsSaved') { drafts.delete(JSON.stringify(data.path)); status('已更新配置，可在源文档中撤销；保存后用于下次构建'); }
        else if (data.type === 'settingsError') status(data.error,true);
        else if (data.type === 'sourceChanged') status('源配置已修改。应用前请刷新配置，避免覆盖外部修改');
      });
      navigate('math'); vscode.postMessage({type:'settingsReady'});
    })();
    `,
  });
}
