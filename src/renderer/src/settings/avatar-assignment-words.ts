// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/** The popup's words (C17–C24; decision 0031). */
export const ASSIGNMENT_WORDS = {
  title: (provider: string): string => `Assign family to ${provider}`,
  close: 'Close',
  assign: 'Assign avatar',
  editFamily: 'Edit family',
  family: 'Eligible families',
  detectedModels: (provider: string): string => `Detected models for ${provider}`,
  strip: (family: string): string => `${family}’s avatars`,
  overrideTitle: 'Override specific avatar',
  overrideDialogTitle: (provider: string): string => `Override specific avatar for ${provider}`,
  overrideHelp: 'Give one model an avatar of its own, whatever its family: select it in the list, then Assign avatar.',
  defaultFamily: (name: string): string => `${name} (default)`,
  sources: { override: 'Override', match: 'Family match', 'family-face': 'Family default', 'built-in-face': 'Built-in default' },
  clear: 'Clear',
  assignBy: 'Assign by',
  byKey: 'Follow CLI key',
  byVersion: 'This version (ID)',
  bindingHelp: 'A version assignment stays with that ID and takes priority. A key assignment follows whichever model the CLI gives that key. If no ID is reported, the key is used.',
  hidden: 'Hidden',
  notListed: 'Not listed now',
  sameModel: (name: string): string => `Same model as ${name}`,
  notFound: 'Not found',
  saveFailed: 'fat-g could not save the change.',
  builtIn: '(built-in)',
  yours: '(yours)',
} as const;

