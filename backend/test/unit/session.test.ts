import { describe, expect, it } from 'vitest';
import { decideBootTransition } from '../../src/services/session';

describe('decideBootTransition', () => {
  it('same boot id -> SAME_BOOT (network blip, no new session)', () => {
    expect(decideBootTransition('boot-1', 'boot-1', false)).toBe('SAME_BOOT');
    expect(decideBootTransition('boot-1', 'boot-1', true)).toBe('SAME_BOOT');
  });

  it('different boot id without clean shutdown -> VM_REPLACED', () => {
    expect(decideBootTransition('boot-1', 'boot-2', false)).toBe('VM_REPLACED');
  });

  it('different boot id after a clean shutdown signal -> REBOOT', () => {
    expect(decideBootTransition('boot-1', 'boot-2', true)).toBe('REBOOT');
  });

  it('no previous session -> treated as a fresh attach (VM_REPLACED branch)', () => {
    expect(decideBootTransition(null, 'boot-9', false)).toBe('VM_REPLACED');
    expect(decideBootTransition(undefined, 'boot-9', false)).toBe('VM_REPLACED');
  });
});
