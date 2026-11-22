import { describe, expect, it } from 'vitest';
import { createPlayerState, playerReducer } from './playerReducer';

const initial = (hasNextYear = true) => createPlayerState({ initialIndex: 1, total: 3, scope: { type: 'year', year: '2026' }, hasNextYear });
const next = { type: 'CONTINUE_YEAR' as const, initialIndex: 0, total: 5, scope: { type: 'year' as const, year: '2025' }, hasNextYear: true };
describe('continuous year playback', () => {
  it('plays through the last frame when another catalogue year exists, preserving speed', () => {
    let state = playerReducer(initial(), { type: 'PLAY' });
    state = playerReducer(state, { type: 'CHANGE_SPEED', delayMs: 500 });
    state = playerReducer(state, { type: 'ADVANCE' });
    expect(state.currentIndex).toBe(2); expect(state.status).toBe('playing');
    state = playerReducer(state, { type: 'YEAR_WAIT', manual: false });
    expect(state.status).toBe('buffering'); expect(state.currentIndex).toBe(2);
    state = playerReducer(state, next);
    expect(state).toMatchObject({ currentIndex: 0, total: 5, status: 'playing', delayMs: 500, scope: { year: '2025' } });
  });
  it('does not restart an explicitly paused player on a manual year change', () => {
    let state = playerReducer(initial(), { type: 'PAUSE' });
    state = playerReducer(state, { type: 'YEAR_WAIT', manual: true });
    expect(playerReducer(state, next).status).toBe('explicitly-paused');
  });
  it('starts a fresh manual resume delay after a slow year load', () => {
    let state = playerReducer(initial(), { type: 'PLAY' });
    state = playerReducer(state, { type: 'YEAR_WAIT', manual: true });
    expect(state.resumeDelayMs).toBeNull();
    state = playerReducer(state, next);
    expect(state.status).toBe('temporarily-paused'); expect(state.resumeDelayMs).toBe(5000);
  });
  it('pausing while buffering survives a late continuation event', () => {
    let state = playerReducer(initial(), { type: 'PLAY' });
    state = playerReducer(state, { type: 'YEAR_WAIT', manual: false });
    state = playerReducer(state, { type: 'PAUSE' });
    expect(playerReducer(state, next).status).toBe('explicitly-paused');
  });
  it('ends at the archive boundary and permits a deep link to the last frame of a nonfinal year', () => {
    expect(playerReducer(playerReducer(initial(false), { type: 'PLAY' }), { type: 'ADVANCE' }).status).toBe('ended');
    const last = createPlayerState({ initialIndex: 2, total: 3, scope: { type: 'year', year: '2026' }, hasNextYear: true });
    expect(playerReducer(last, { type: 'READY' }).status).toBe('initial-delay');
  });
});
