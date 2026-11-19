// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { author, version } from '../../../../package.json';
import license from '../../../../LICENSE?raw';
import { Section } from './Section';
import styles from './AboutSection.module.css';

/** Static build information stays available even when preferences cannot be read. */
export function AboutSection() {
  return (
    <Section section="about">
      <div className={styles.about}>
        <header>
          <h3>fat-g</h3>
          <p>Fun Agent Team – Go!</p>
        </header>
        <dl className={styles.facts}>
          <dt>Created by</dt><dd>{author}</dd>
          <dt>Version</dt><dd>{version}</dd>
          <dt>Project</dt><dd>https://github.com/fbdesignpro/fat-g</dd>
          <dt>License</dt><dd>MIT</dd>
        </dl>
        <p>Credit to the original project is appreciated, but is not an additional license requirement.</p>
        <details className={styles.license}>
          <summary>Read the MIT license</summary>
          <pre>{license.trim()}</pre>
        </details>
        <p>Third-party components and assets retain their own licenses and notices, included with distributed builds.</p>
        <p>Not affiliated with, endorsed by, or supported by Anthropic or OpenAI.</p>
      </div>
    </Section>
  );
}
