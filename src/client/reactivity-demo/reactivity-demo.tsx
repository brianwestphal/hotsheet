/**
 * Reactivity demo — entry point.
 *
 * Self-contained showcase of the §63 reactivity primitive (signals + stores +
 * morphdom-driven re-renders + event delegation + SVG-aware toElement). NOT
 * wired into the rest of the app — every section here uses ONLY the new
 * primitive and renders into its own root container.
 *
 * Reachable at `/_demo/reactivity` while the dev server is running. See
 * `docs/63-reactivity-demo-plan.md` for the plan being demonstrated.
 */

import { mountCart } from './sections/cartSection.js';
import { mountCounter } from './sections/counterSection.js';
import { mountFocusSurvival } from './sections/focusSurvivalSection.js';
import { mountKeyedList } from './sections/keyedListSection.js';
import { mountMorphSkip } from './sections/morphSkipSection.js';
import { mountSvgRender } from './sections/svgSection.js';
import { mountTier2Capture } from './sections/tier2CaptureSection.js';

document.addEventListener('DOMContentLoaded', () => {
  mountCounter(document.getElementById('section-counter')!);
  mountCart(document.getElementById('section-cart')!);
  mountFocusSurvival(document.getElementById('section-focus')!);
  mountKeyedList(document.getElementById('section-list')!);
  mountMorphSkip(document.getElementById('section-skip')!);
  mountSvgRender(document.getElementById('section-svg')!);
  mountTier2Capture(document.getElementById('section-tier2')!);
});
