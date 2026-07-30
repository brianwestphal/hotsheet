// HS-9497 (docs/132 §132.9.2), step 1 — decouple the config-UI renderer from plugin storage.
//
// `pluginConfigDialog.tsx` renders preference rows well, and docs/132 wants AI-tool
// settings to reuse it rather than grow a fourth hand-written settings surface. But the
// renderer was welded to docs/18 plugin storage in three places — the
// `plugin:<id>:<key>` setting-key namespace, the `getPluginGlobalConfig` /
// `setPluginGlobalConfig` pair, and `validatePluginField`. AI-tool settings live
// somewhere else entirely: plain `FileSettings` keys, `~/.hotsheet` global config,
// docs/95 shared-vs-local layer routing, and zod validation.
//
// So the renderer stops knowing where values live, and a STORE supplies read / write /
// validate. The plugin store below is the existing behavior, moved verbatim — this step
// deliberately changes no storage semantics, because a decoupling that also alters where
// values land is impossible to review.
//
// The `namespace` field is not decoration: the renderer builds DOM ids from it
// (`pref-input-<namespace>-<key>`), and two stores rendering into the same dialog would
// collide without it.

import { getPluginGlobalConfig, getSettings, setPluginGlobalConfig, updateSettings, validatePluginField } from '../api/index.js';
import type { PluginPreference } from './pluginTypes.js';

/** A field-level validation verdict, as the renderer displays it. */
export interface PreferenceValidation {
  status: string;
  message: string;
}

/**
 * Where a rendered preference's value is read from and written to.
 *
 * Implementations are storage adapters, NOT policy: deciding which layer a value belongs
 * in (docs/95 shared vs local) is the store's business precisely so the renderer never
 * has to ask.
 */
export interface PreferenceStore {
  /** Unique per rendered group — namespaces the row DOM ids. */
  readonly namespace: string;
  /** Current value, or null when unset (the renderer then falls back to `pref.default`). */
  read: (pref: PluginPreference) => Promise<string | null>;
  /** Persist a value. Fire-and-forget: the renderer does not await saves. */
  write: (pref: PluginPreference, value: string) => void;
  /** Field validation, or null when the store has nothing to say. */
  validate: (key: string, value: string) => Promise<PreferenceValidation | null>;
}

/**
 * The docs/18 plugin store — the renderer's original behavior, unchanged.
 *
 * `scope: 'global'` routes to the machine-global plugin config; anything else to a
 * project setting under the `plugin:<id>:<key>` namespace. That split is a plugin-system
 * concept, which is exactly why it belongs here rather than in the renderer.
 */
export function pluginPreferenceStore(pluginId: string): PreferenceStore {
  const settingKey = (pref: PluginPreference): string => `plugin:${pluginId}:${pref.key}`;
  return {
    namespace: pluginId,
    read: async (pref) => {
      if (pref.scope === 'global') return (await getPluginGlobalConfig(pluginId, pref.key)) ?? null;
      const settings = await getSettings();
      return settings[settingKey(pref)] ?? null;
    },
    write: (pref, value) => {
      if (pref.scope === 'global') void setPluginGlobalConfig(pluginId, pref.key, value);
      else void updateSettings({ [settingKey(pref)]: value });
    },
    validate: async (key, value) => (await validatePluginField(pluginId, key, value)) ?? null,
  };
}
