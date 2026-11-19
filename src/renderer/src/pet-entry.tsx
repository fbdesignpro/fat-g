// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { connectControlAudio } from './audio/controls';
import { boot } from './boot';
import { PetApp } from './PetApp';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/global.css';

boot('pet', <PetApp />);

const stopControlAudio = connectControlAudio();
if (import.meta.hot) import.meta.hot.dispose(stopControlAudio);
