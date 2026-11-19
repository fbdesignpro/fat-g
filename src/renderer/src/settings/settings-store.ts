// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Whether the Settings dialog is open, which tab it shows, and which part of it to show. In memory
// only, never saved (C50; M101, C7, C13): it is where you happen to be, not something you configured.
import { create } from 'zustand';

/**
 * The dialog's tabs in display and keyboard-navigation order. General opens first.
 */
export const SETTINGS_SECTIONS = ['general', 'accounts', 'appearance', 'avatars', 'audio', 'presets', 'storage', 'diagnostics', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_SECTION_TITLES: Readonly<Record<SettingsSection, string>> = {
  general: 'General',
  accounts: 'Accounts',
  appearance: 'Appearance',
  avatars: 'Avatars',
  audio: 'Audio',
  presets: 'Presets',
  storage: 'Storage',
  diagnostics: 'Diagnostics',
  about: 'About',
};

/** One provider's part of the Accounts tab, or one account's row in it (M11, C41; M14b, C38). */
export type AccountTarget = { readonly provider: string; readonly instanceId?: string };

/** A tab, or a provider or an account in Accounts: a usage block opens Settings at its own account. */
export type SettingsTarget = { readonly section: SettingsSection } | AccountTarget;

export interface SettingsView {
  readonly open: boolean;
  /** Where to take the reader when it opens; null opens it at the top of the shown tab. */
  readonly target: SettingsTarget | null;
  /** The shown tab: kept when the dialog closes, for the next opening in this run (M101, C7). */
  readonly tab: SettingsSection;
}

export const useSettings = create<SettingsView>()(() => ({ open: false, target: null, tab: 'general' }));

/** With no target it shows the tab it showed last; with one, that target's tab (M101, C7, C8). */
export function openSettings(target: SettingsTarget | null = null): void {
  useSettings.setState((state) => ({ open: true, target, tab: target === null ? state.tab : targetTab(target) }));
}

export function closeSettings(): void {
  useSettings.setState({ open: false, target: null });
}

export function selectSettingsTab(tab: SettingsSection): void {
  useSettings.setState({ tab });
}

/** The tab a target lands in: its own, or Accounts for a provider or an account (M101, C3). */
export function targetTab(target: SettingsTarget): SettingsSection {
  return 'section' in target ? target.section : 'accounts';
}

/** A tab's own id, which labels its panel. */
export function settingsTabId(section: SettingsSection): string {
  return `settings-tab-${section}`;
}

/** The one panel's id: only the shown tab's is mounted (M101, C5). */
export const SETTINGS_PANEL_ID = 'settings-panel';

/** The id of a provider's or an account's heading in Accounts. */
export function targetHeadingId(target: AccountTarget): string {
  return target.instanceId === undefined ? `settings-provider-${target.provider}` : `settings-instance-${target.provider}-${target.instanceId.toLowerCase()}`;
}

/**
 * What a target lands on, the nearest first: a section's tab (M101, C6); an account's heading, its
 * provider's standing in when the account has no row of its own, which is when its provider lists
 * only one (M14b, C32, C34).
 */
export function targetLandingIds(target: SettingsTarget): string[] {
  if ('section' in target) return [settingsTabId(target.section)];
  if (target.instanceId === undefined) return [targetHeadingId(target)];
  return [targetHeadingId(target), targetHeadingId({ provider: target.provider })];
}
