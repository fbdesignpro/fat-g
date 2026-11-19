// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { SessionSearch } from '../../sessions/search/service';
import type { InvokeHandlers } from '../dispatch';

export function sessionSearchHandlers(search: SessionSearch): Pick<InvokeHandlers, 'sessions:search' | 'sessions:closeSearch'> {
  return {
    'sessions:closeSearch'() { search.release(); return null; },
    async 'sessions:search'(request) {
      try { return await search.search(request); } catch {
        // Even a development log must not receive an index error containing the query or text.
        return { status: 'messages-unavailable', hits: [], total: 0, more: false };
      }
    },
  };
}
