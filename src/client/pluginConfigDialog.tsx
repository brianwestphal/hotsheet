import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { TIMERS } from './constants/timers.js';
import { toElement } from './dom.js';
import type { ConfigLayoutItem, PluginPreference } from './pluginTypes.js';
import { labelColorClass } from './pluginTypes.js';

export function renderConfigLayout(container: HTMLElement, items: ConfigLayoutItem[], pluginId: string, prefsMap: Map<string, PluginPreference>) {
  for (const item of items) {
    switch (item.type) {
      case 'preference': {
        const pref = item.key != null && item.key !== '' ? prefsMap.get(item.key) : undefined;
        if (pref) container.appendChild(createPreferenceRow(pluginId, pref));
        break;
      }
      case 'divider':
        container.appendChild(toElement(<hr className="config-divider" />));
        break;
      case 'spacer':
        container.appendChild(toElement(<div className="config-spacer"></div>));
        break;
      case 'label':
        container.appendChild(toElement(
          <div className={labelColorClass(item.color)} id={`config-label-${pluginId}-${item.id}`}>{item.text ?? ''}</div>
        ));
        break;
      case 'button': {
        const btn = toElement(
          <button className={`btn btn-sm${item.style === 'primary' ? ' btn-primary' : ''}`}>
            {item.icon != null && item.icon !== '' ? raw(item.icon) : null}
            {item.label ?? 'Action'}
          </button>
        );
        btn.addEventListener('click', async () => {
          if (item.action == null || item.action === '') return;
          (btn as HTMLButtonElement).disabled = true;
          try {
            await api(`/plugins/${pluginId}/action`, {
              method: 'POST', body: { actionId: item.action },
            });
            const labelsRes = await api<Record<string, { text: string; color?: string }>>(`/plugins/config-labels/${pluginId}`);
            for (const [labelId, payload] of Object.entries(labelsRes)) {
              const el = container.querySelector(`#config-label-${pluginId}-${labelId}`);
              if (el) {
                el.textContent = payload.text;
                el.className = labelColorClass(payload.color);
              }
            }
          } catch (e) {
            console.error('Config action failed:', e);
          }
          (btn as HTMLButtonElement).disabled = false;
        });
        container.appendChild(btn);
        break;
      }
      case 'group': {
        const collapsed = item.collapsed === true;
        const chevronRight = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
        const chevronDown = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
        const group = toElement(
          <div className={`config-group${collapsed ? ' collapsed' : ''}`}>
            <div className="config-group-header">
              <span className="config-group-title">{item.title ?? 'Group'}</span>
              <span className="config-group-chevron">{raw(collapsed ? chevronRight : chevronDown)}</span>
            </div>
            <div className="config-group-body" style={collapsed ? 'display:none' : ''}></div>
          </div>
        );
        group.querySelector('.config-group-header')!.addEventListener('click', () => {
          const bodyEl = group.querySelector('.config-group-body') as HTMLElement;
          const chevron = group.querySelector('.config-group-chevron') as HTMLElement;
          const isCollapsed = bodyEl.style.display === 'none';
          bodyEl.style.display = isCollapsed ? '' : 'none';
          chevron.innerHTML = isCollapsed ? chevronDown : chevronRight;
          group.classList.toggle('collapsed', !isCollapsed);
        });
        if (item.items) {
          renderConfigLayout(group.querySelector('.config-group-body')!, item.items, pluginId, prefsMap);
        }
        container.appendChild(group);
        break;
      }
    }
  }
}

export function createPreferenceRow(pluginId: string, pref: PluginPreference): HTMLElement {
  const isGlobal = pref.scope === 'global';
  const row = toElement(
    <div className="plugin-pref-row">
      <label className="plugin-pref-label">
        {pref.label}
        {pref.required === true ? <span className="plugin-pref-required">*</span> : null}
        {isGlobal ? <span className="global-setting-badge">Global</span> : null}
      </label>
      {pref.description != null && pref.description !== '' ? <span className="settings-hint">{pref.description}</span> : null}
      <div className="plugin-pref-input" id={`pref-input-${pluginId}-${pref.key}`}></div>
      <div className="plugin-pref-validation" id={`pref-validation-${pluginId}-${pref.key}`}></div>
    </div>
  );

  const inputContainer = row.querySelector(`#pref-input-${pluginId}-${pref.key}`)!;

  if (isGlobal) {
    void api<{ value: string | null }>(`/plugins/${pluginId}/global-config/${pref.key}`).then(result => {
      renderPrefInput(inputContainer as HTMLElement, pluginId, pref, result.value ?? String(pref.default ?? ''));
    }).catch(() => {
      renderPrefInput(inputContainer as HTMLElement, pluginId, pref, String(pref.default ?? ''));
    });
  } else {
    void api<Record<string, string>>('/settings').then(settings => {
      const settingKey = `plugin:${pluginId}:${pref.key}`;
      const currentValue = settings[settingKey] ?? String(pref.default ?? '');
      renderPrefInput(inputContainer as HTMLElement, pluginId, pref, currentValue);
    }).catch(() => {
      renderPrefInput(inputContainer as HTMLElement, pluginId, pref, String(pref.default ?? ''));
    });
  }

  return row;
}

function renderPrefInput(container: HTMLElement, pluginId: string, pref: PluginPreference, currentValue: string) {
  container.innerHTML = '';
  let input: HTMLElement;

  if ((pref.type === 'select' || pref.type === 'dropdown') && pref.options) {
    input = createSelectInput(pluginId, pref, currentValue);
  } else if (pref.type === 'combo' && pref.options) {
    input = createComboInput(pluginId, pref, currentValue);
  } else if (pref.type === 'boolean') {
    input = createBooleanInput(pluginId, pref, currentValue);
  } else {
    input = createTextInput(pluginId, pref, currentValue);
  }

  container.appendChild(input);
}

function createSelectInput(pluginId: string, pref: PluginPreference, currentValue: string): HTMLElement {
  const select = toElement(
    <select className="settings-select">
      {pref.options!.map(opt =>
        <option value={opt.value} selected={opt.value === currentValue}>{opt.label}</option>
      )}
    </select>
  ) as HTMLSelectElement;
  select.addEventListener('change', () => savePrefValue(pluginId, pref, select.value));
  return select;
}

function createComboInput(pluginId: string, pref: PluginPreference, currentValue: string): HTMLElement {
  const wrapper = toElement(<div className="plugin-combo-wrapper"></div>);
  const textInput = toElement(
    <input type="text" className="settings-input plugin-combo-input" value={currentValue} autocomplete="off" />
  ) as HTMLInputElement;
  const dropdown = toElement(<div className="plugin-combo-dropdown"></div>);

  function positionDropdown() {
    const rect = textInput.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 2}px`;
    dropdown.style.width = `${rect.width}px`;
  }

  function renderOptions(filter = '') {
    dropdown.innerHTML = '';
    const lower = filter.toLowerCase();
    const filtered = pref.options!.filter(opt =>
      lower === '' || opt.label.toLowerCase().includes(lower) || opt.value.toLowerCase().includes(lower),
    );
    if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
    for (const opt of filtered) {
      const item = toElement(
        <div className={`plugin-combo-option${opt.value === textInput.value ? ' active' : ''}`}>{opt.label}</div>,
      );
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        textInput.value = opt.value;
        dropdown.style.display = 'none';
        savePrefValue(pluginId, pref, opt.value);
      });
      dropdown.appendChild(item);
    }
    positionDropdown();
    dropdown.style.display = 'block';
  }

  textInput.addEventListener('focus', () => renderOptions(textInput.value));
  textInput.addEventListener('input', () => renderOptions(textInput.value));
  textInput.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none'; }, 150);
    savePrefValue(pluginId, pref, textInput.value);
  });

  wrapper.appendChild(textInput);
  document.body.appendChild(dropdown);
  return wrapper;
}

function createBooleanInput(pluginId: string, pref: PluginPreference, currentValue: string): HTMLElement {
  const checkbox = toElement(
    <label className="settings-checkbox-label">
      <input type="checkbox" checked={currentValue === 'true'} />
      <span>{pref.label}</span>
    </label>
  );
  const cb = checkbox.querySelector('input')!;
  cb.addEventListener('change', () => savePrefValue(pluginId, pref, String(cb.checked)));
  return checkbox;
}

function createTextInput(pluginId: string, pref: PluginPreference, currentValue: string): HTMLElement {
  const textInput = toElement(
    <input
      type={pref.secret === true ? 'password' : 'text'}
      className="settings-input"
      value={currentValue}
      placeholder={pref.description ?? ''}
    />
  ) as HTMLInputElement;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  textInput.addEventListener('input', () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => savePrefValue(pluginId, pref, textInput.value), TIMERS.PREF_SAVE_MS);
  });
  return textInput;
}

function savePrefValue(pluginId: string, pref: PluginPreference, value: string) {
  if (pref.scope === 'global') {
    void api(`/plugins/${pluginId}/global-config`, { method: 'POST', body: { key: pref.key, value } });
  } else {
    const settingKey = `plugin:${pluginId}:${pref.key}`;
    void api('/settings', { method: 'PATCH', body: { [settingKey]: value } });
  }
  void validateField(pluginId, pref.key, value);
}

async function validateField(pluginId: string, key: string, value: string) {
  const el = document.getElementById(`pref-validation-${pluginId}-${key}`);
  if (!el) return;
  try {
    const result = await api<{ status: string; message: string } | null>(
      `/plugins/validate/${pluginId}`, { method: 'POST', body: { key, value } },
    );
    if (!result) { el.textContent = ''; el.className = 'plugin-pref-validation'; return; }
    el.textContent = result.message;
    el.className = `plugin-pref-validation ${result.status}`;
  } catch {
    el.textContent = '';
    el.className = 'plugin-pref-validation';
  }
}
