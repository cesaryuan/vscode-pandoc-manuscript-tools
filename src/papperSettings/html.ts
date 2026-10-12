import { buildCslPickerHtml } from "../inlayHints/csl/pickerHtml";
import { SETTINGS_SECTIONS } from "./model";
import { SETTINGS_GROUPS, SETTINGS_LABELS } from "./presentation";

/** Builds one settings window with shared navigation, field editors and the embedded Zotero bibliography section. */
export function buildPapperSettingsHtml(): string {
  const navigation = SETTINGS_SECTIONS.map((section) => `<button class="nav-item" data-section="${section.id}">${section.title}</button>`).join("");
  return buildCslPickerHtml({
    styles: `
    [hidden] { display:none !important; }
    body { height:100vh; display:flex; flex-direction:column; overflow:hidden; line-height:1.5; }
    .settings-head { flex-shrink:0; padding:20px 28px; border-bottom:1px solid var(--vscode-panel-border); }
    .settings-heading { display:flex; align-items:baseline; gap:18px; margin-bottom:16px; min-width:0; }
    .settings-head h1 { margin:0; font-size:22px; letter-spacing:-.3px; flex-shrink:0; }
    #source { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .settings-tools { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .settings-tools label { color:var(--vscode-descriptionForeground); }
    #open-source { margin-left:auto; }
    select,textarea { font:inherit; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border,var(--vscode-panel-border)); padding:9px 12px; border-radius:5px; }
    input { border-color:var(--vscode-input-border,var(--vscode-panel-border)); border-radius:5px; }
    input:focus,select:focus,textarea:focus { outline:1px solid var(--vscode-focusBorder); outline-offset:1px; }
    button { border-radius:5px; } .secondary:hover { background:var(--vscode-button-secondaryHoverBackground,var(--vscode-list-hoverBackground)); }
    .settings-layout { display:grid; grid-template-columns:210px minmax(0,1fr); flex:1; min-height:0; }
    nav { padding:24px 12px; border-right:1px solid var(--vscode-panel-border); overflow:auto; background:var(--vscode-sideBar-background,var(--vscode-editor-background)); }
    .nav-item { display:block; width:100%; text-align:left; background:transparent; color:var(--vscode-foreground); padding:11px 14px; margin-bottom:6px; border:1px solid transparent; }
    .nav-item:hover { background:var(--vscode-list-hoverBackground); }
    .nav-item[aria-current="page"] { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); border-left:3px solid var(--vscode-focusBorder); padding-left:12px; font-weight:600; }
    .settings-main { min-width:0; min-height:0; } .page { height:100%; padding:28px 32px; gap:18px; }
    #field-page { height:100%; overflow:auto; padding:28px 32px 48px; scrollbar-gutter:stable; }
    .section-heading,#fields,#style-picker { max-width:1040px; margin-left:auto; margin-right:auto; }
    #field-page h2 { margin:0 0 8px; font-size:22px; font-weight:600; } #section-help { margin:0 0 28px; }
    .setting-group { margin-bottom:28px; }
    .group-title { font-size:14px; font-weight:600; margin:0 0 12px; }
    .setting { padding:18px 20px; border:1px solid var(--vscode-panel-border); border-radius:8px; margin-bottom:10px; background:var(--vscode-settings-rowHoverBackground,var(--vscode-editor-background)); }
    .setting-heading { display:flex; align-items:center; gap:12px; justify-content:space-between; margin-bottom:6px; }
    .setting label { font-size:14px; font-weight:600; }
    .setting-badge { flex-shrink:0; font-size:11px; font-weight:400; padding:2px 8px; border:1px solid var(--vscode-panel-border); border-radius:10px; color:var(--vscode-descriptionForeground); }
    .setting-badge.configured { color:var(--vscode-textLink-foreground); border-color:var(--vscode-textLink-foreground); }
    .setting-description { color:var(--vscode-descriptionForeground); margin-bottom:14px; overflow-wrap:anywhere; }
    .setting-controls { display:flex; gap:12px; align-items:flex-start; }
    .setting-controls input,.setting-controls select,.setting-controls textarea { flex:1; width:0; min-width:0; }
    .setting-controls textarea { min-height:100px; resize:vertical; font-family:var(--vscode-editor-font-family,monospace); }
    .setting-actions { display:flex; gap:8px; flex-shrink:0; }
    .setting-actions button { white-space:nowrap; }
    .setting-meta { display:flex; gap:12px; align-items:baseline; justify-content:space-between; margin-top:12px; font-size:12px; }
    .setting-status { min-width:0; overflow-wrap:anywhere; white-space:pre-wrap; }
    .setting-path { flex-shrink:0; max-width:55%; color:var(--vscode-descriptionForeground); }
    .setting-path summary { cursor:pointer; text-align:right; }
    .setting-path code { display:block; margin-top:8px; overflow-wrap:anywhere; font-family:var(--vscode-editor-font-family,monospace); }
    .advanced-settings { margin-top:12px; }
    .advanced-settings > summary { cursor:pointer; color:var(--vscode-descriptionForeground); padding:10px 0; }
    .advanced-settings[open] > summary { margin-bottom:8px; }
    #style-picker { display:flex; align-items:center; gap:12px; padding:16px 20px; margin-bottom:24px; border:1px solid var(--vscode-panel-border); border-radius:8px; }
    #style-picker label { flex-shrink:0; font-weight:600; } #style-name { max-width:420px; }
    #message:empty { display:none; } #message { margin-top:14px; padding:10px 12px; border-left:3px solid var(--vscode-focusBorder); background:var(--vscode-textBlockQuote-background); }
    .error { color:var(--vscode-errorForeground); }
    #csl-config { flex-shrink:0; } #csl-config .setting { padding:14px 18px; margin:0; }
    #csl-config > .advanced-settings { max-height:230px; overflow:auto; }
    #csl-config .setting-description { margin-bottom:10px; }
    #bibliography .content { gap:18px; grid-template-columns:minmax(190px,32%) minmax(0,1fr); min-height:260px; }
    #bibliography { overflow:auto; } #bibliography h1 { font-size:22px; }
    #bibliography footer { padding-top:12px; border-top:1px solid var(--vscode-panel-border); }
    #bibliography footer button { flex-shrink:0; }
    #list,.preview { border-radius:8px; } #search { padding:11px 14px; }
    @media(max-width:900px) { .settings-layout { grid-template-columns:180px minmax(0,1fr); } #field-page,.page { padding:24px; } .setting-controls { flex-wrap:wrap; } .setting-controls input,.setting-controls select,.setting-controls textarea { flex-basis:100%; width:100%; } .setting-actions { margin-left:auto; } }
    @media(max-width:780px) { .settings-layout { grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); } nav { display:flex; padding:8px; border-right:0; border-bottom:1px solid var(--vscode-panel-border); overflow-x:auto; } .nav-item { white-space:nowrap; width:auto; margin:0 4px 0 0; } .settings-heading { flex-wrap:wrap; gap:4px 16px; margin-bottom:12px; } .settings-head { padding:16px 20px; } }
    @media(max-width:650px) { #bibliography .content { grid-template-columns:1fr; grid-template-rows:190px minmax(260px,1fr); } #field-page,.page { padding:20px 16px; } .setting { padding:16px; } .setting-meta { align-items:flex-start; flex-direction:column; gap:6px; } .setting-path { max-width:100%; } .setting-path summary { text-align:left; } #style-picker { flex-wrap:wrap; padding:16px; } #style-name { flex-basis:100%; order:1; } #choose-style { margin-left:auto; } .settings-tools { gap:8px; } #open-source { margin-left:0; } #source { width:100%; } }
    `,
    before: `<header class="settings-head"><div class="settings-heading"><h1>Papper 设置</h1><div id="source" class="muted">正在读取配置…</div></div>
      <div class="settings-tools"><label for="scope">设置范围</label><select id="scope"><option value="main">当前稿件 / 项目</option><option value="reply">审稿回复覆盖</option></select>
      <button id="refresh" class="secondary">刷新配置</button><button id="open-source" class="secondary">查看源配置</button></div>
      <div id="message" role="status" aria-live="polite"></div></header>
      <div class="settings-layout"><nav aria-label="Papper 设置分区">${navigation}</nav><div class="settings-main">
      <main id="field-page"><div class="section-heading"><h2 id="section-title"></h2><p id="section-help" class="muted">每项单独应用 · 未设置的选项沿用继承或默认值 · 保存源文档后用于下次构建</p></div>
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
      const labels = ${JSON.stringify(SETTINGS_LABELS)};
      const groups = ${JSON.stringify(SETTINGS_GROUPS)};
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
        const label = document.createElement('label'); label.textContent = labels[row.title] ?? row.description;
        // Shared leaf names such as left/right mean indentation inside a Word style, not page margins.
        if (row.path.some(part => normalize(part) === 'indentation')) label.textContent = {left:'左缩进',right:'右缩进'}[row.title] ?? label.textContent;
        if (section === 'docx' && row.title === 'font') label.textContent = '旧版字体对象';
        const inputId = 'setting-' + row.path.map(encodeURIComponent).join('-'); label.htmlFor = inputId;
        const badge = document.createElement('span'); badge.className = 'setting-badge' + (row.configured ? ' configured' : ''); badge.textContent = row.configured ? '已设置' : row.inherited !== undefined ? '继承' : '默认';
        const heading = document.createElement('div'); heading.className = 'setting-heading'; heading.append(label,badge);
        const description = document.createElement('div'); description.className = 'setting-description'; description.textContent = row.description; description.hidden = row.description === label.textContent;
        const path = document.createElement('details'); path.className = 'setting-path';
        const pathSummary = document.createElement('summary'); pathSummary.textContent = '配置字段';
        const pathValue = document.createElement('code'); pathValue.textContent = row.path.join(' › '); path.append(pathSummary,pathValue);
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
        const note = document.createElement('div'); note.className = 'setting-status muted'; note.textContent = row.configured ? '当前范围的覆盖配置' : row.inherited !== undefined ? '继承值：' + row.inherited : '沿用 Papper 默认或其他继承配置';
        const actions = document.createElement('div'); actions.className = 'setting-actions'; actions.append(save,reset);
        const meta = document.createElement('div'); meta.className = 'setting-meta'; meta.append(note,path);
        controls.append(input,actions); container.append(heading,description,controls,meta); return container;
      }
      /** Matches schema group keys to existing camelCase, kebab-case or snake_case source paths. */
      function normalize(key) { return key.replace(/[-_]/g,'').toLowerCase(); }
      /** Keeps structured YAML editors accessible without competing with their individual leaf controls. */
      function fieldCards(rows) {
        return rows.map(row => {
          const hasChildren = rows.some(child => child.path.length > row.path.length && row.path.every((key,index) => child.path[index] === key));
          if (!hasChildren) return settingRow(row);
          const editor = document.createElement('details'); editor.className = 'advanced-settings';
          const summary = document.createElement('summary'); summary.textContent = '直接编辑' + (labels[row.title] ?? row.description) + (row.kind === 'yaml' ? '（YAML）' : '（完整值）');
          editor.append(summary,settingRow(row)); return editor;
        }).sort((left,right) => Number(left.tagName === 'DETAILS') - Number(right.tagName === 'DETAILS'));
      }
      /** Groups related settings while retaining any future schema fields in a visible fallback group. */
      function renderGroups(rows) {
        const nodes = []; const remaining = new Set(rows);
        // Group by the field below the shared scope, so a custom Word style named "font" cannot capture unrelated rows.
        const fieldIndex = Math.min(...rows.map(row => row.path.length)) - 1;
        const definitions = [...(groups[section] ?? []),{title:'其他设置',keys:[]}];
        for (const definition of definitions) {
          const selected = [...remaining].filter(row => !definition.keys.length || definition.keys.some(field => normalize(field) === normalize(row.path[fieldIndex])));
          if (!selected.length) continue;
          selected.forEach(row => remaining.delete(row));
          const group = document.createElement(definition.collapsed ? 'details' : 'section'); group.className = 'setting-group' + (definition.collapsed ? ' advanced-settings' : '');
          const heading = document.createElement(definition.collapsed ? 'summary' : 'h3'); heading.className = 'group-title'; heading.textContent = definition.title;
          group.append(heading,...fieldCards(selected)); nodes.push(group);
        }
        return nodes;
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
          const source = document.getElementById('source'); source.textContent = data.sourceLabel; source.title = data.sourceLabel;
          document.getElementById('section-title').textContent = data.title;
          document.getElementById('style-name').value = data.styleName;
          const names = data.styleNames.map(name => { const option = document.createElement('option'); option.value = name; return option; });
          document.getElementById('style-names').replaceChildren(...names);
          const target = data.section === 'bibliography' ? document.getElementById('csl-config') : document.getElementById('fields');
          if (data.section === 'bibliography') {
            const csl = data.rows.find(row => row.title === 'csl');
            const more = document.createElement('details'); more.className = 'advanced-settings'; const summary = document.createElement('summary'); summary.textContent = '更多参考文献设置';
            more.append(summary,...data.rows.filter(row => row !== csl).map(settingRow)); target.replaceChildren(settingRow(csl),more);
          } else target.replaceChildren(...renderGroups(data.rows));
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
