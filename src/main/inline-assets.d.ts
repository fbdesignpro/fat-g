// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An image a provider module imports with `?inline` (its logo or stream glow): Vite gives it as a
// `data:` address, built into the bundle, so no file ships beside it.
declare module '*.png?inline' {
  const address: string;
  export default address;
}
