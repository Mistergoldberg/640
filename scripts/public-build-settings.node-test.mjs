import test from 'node:test';
import assert from 'node:assert/strict';
import { publicBuildSettings } from './public-build-settings.mjs';

test('release defaults enable seamless browsing without homepage autoplay; explicit off remains supported', () => {
  assert.equal(publicBuildSettings({}).seamlessYearSegments, true);
  assert.equal(publicBuildSettings({}).homepageAutoplayer, false);
  for (const value of ['0', '', 'false', 'yes']) assert.equal(publicBuildSettings({ VITE_SEAMLESS_YEAR_SEGMENTS: value }).seamlessYearSegments, false);
  for (const value of ['1', 'true', 'TRUE']) assert.equal(publicBuildSettings({ VITE_SEAMLESS_YEAR_SEGMENTS: value }).seamlessYearSegments, true);
});
