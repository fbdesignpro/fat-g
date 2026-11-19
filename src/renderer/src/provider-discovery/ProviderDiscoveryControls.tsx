// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';
import { discoveryProviderText } from './words';

/** Always available in Accounts, including when a provider is manually switched off. */
export function ProviderDiscoveryControls() {
  const discovery = useAppState((state) => state.snapshot?.providerDiscovery);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (discovery === undefined) return null;
  const check = async (): Promise<void> => {
    setPending(true);
    setFeedback(null);
    try { await invoke('providers:discover', null); }
    catch { setFeedback('Could not check for providers. Try again.'); }
    finally { setPending(false); }
  };
  return (
    <div>
      <button type="button" disabled={pending || discovery.checking} onClick={() => void check()}>Check for providers</button>
      <p>Installed CLIs are checked at launch and when you return, at most once a minute. Providers you switch off stay off.</p>
      <ul>
        {discovery.providers.map((provider) => (
          <li key={provider.id}><strong>{provider.displayName}:</strong> {discoveryProviderText(provider)}{provider.checkFailed && provider.presence !== 'unknown' && ' The latest check failed; keeping the previous result.'}</li>
        ))}
      </ul>
      {discovery.historyIssue !== null && <p role="status">{discovery.historyIssue === 'unavailable' ? 'Saved detection history could not be read and has been left unchanged. Changes can only be remembered for this run.' : 'Detection history could not be saved. This notice may return after restarting fat-g.'}</p>}
      {feedback !== null && <p role="status">{feedback}</p>}
    </div>
  );
}
