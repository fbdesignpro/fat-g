// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CatalogService } from '../../services/catalog-service';
import type { InvokeHandlers } from '../dispatch';

/** Settings' Reload (M13, C43, C58): catalog.json read again, and its status as the answer. */
export function catalogHandlers(catalog: Pick<CatalogService, 'reload'>): Pick<InvokeHandlers, 'catalog:reload'> {
  return {
    'catalog:reload': () => catalog.reload(),
  };
}
