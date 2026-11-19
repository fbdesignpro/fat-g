// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { connectAudio } from './audio/store';
import { connectControlAudio } from './audio/controls';
import { App } from './App';
import { boot } from './boot';
import { connectDrafts } from './chat/composer/composer-store';
import { connectReveal } from './sessions/select';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/global.css';

// Main's ask for the drafts the page has not handed over, before its window closes or fat-g quits (M23, C31).
connectDrafts();
// A press on a session in the Pet window, which this page opens as a press on its capsule (decision 0010).
connectReveal();
boot('main', <App />);

const stopAudio = connectAudio();
const stopControlAudio = connectControlAudio();
if (import.meta.hot) import.meta.hot.dispose(() => { stopAudio(); stopControlAudio(); });
