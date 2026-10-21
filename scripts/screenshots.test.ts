import { describe, expect, it } from 'vitest';
import { findBrowser, README_SCENES } from './screenshots.ts';

describe('screenshots script', () => {
  it('prefers BENCHTOP_BROWSER, and finds nothing where nothing is installed', () => {
    expect(findBrowser({ BENCHTOP_BROWSER: '/opt/my-chromium' }, 'linux')).toBe('/opt/my-chromium');
    expect(findBrowser({ PATH: '/nonexistent-benchtop-dir' }, 'linux')).toBeUndefined();
    expect(findBrowser({}, 'win32')).toBeUndefined();
  });

  it('has a README scene for every image the README shows', () => {
    expect(README_SCENES.map((s) => s.name).sort()).toEqual(['esp32-neopixel', 'logic-analyzer', 'uno-neopixel', 'uno-oled']);
  });
});
