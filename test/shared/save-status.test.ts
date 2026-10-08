import { describe, expect, it } from 'vitest';
import {
  cleanSnapshotLabel,
  formatClockTime,
  projectNameError,
  SAVE_OVERDUE_MS,
  saveLabel,
  SaveTracker,
  snapshotSummary,
  suggestCopyName,
  touchesProject,
} from '../../src/shared/save-status.ts';

describe('SaveTracker', () => {
  it('starts clean and goes dirty on a send until a save covers it', () => {
    const t = new SaveTracker();
    expect(t.state(0)).toEqual({ kind: 'clean', savedAt: null });
    t.sent(100);
    expect(t.state(200)).toEqual({ kind: 'dirty', since: 100, overdue: false });
    // A save that cannot include our in-flight patch does not clear it.
    t.saved(150);
    expect(t.state(200).kind).toBe('dirty');
    t.changed(true, 300);
    t.saved(400);
    expect(t.state(500)).toEqual({ kind: 'clean', savedAt: 400 });
  });

  it('counts changes from other windows and flags overdue saves', () => {
    const t = new SaveTracker();
    t.changed(false, 1000);
    expect(t.state(1000 + SAVE_OVERDUE_MS + 1)).toEqual({ kind: 'dirty', since: 1000, overdue: true });
    t.saved(9000);
    expect(t.state(9001)).toEqual({ kind: 'clean', savedAt: 9000 });
  });

  it('a resync drops in-flight patches; reset forgets everything', () => {
    const t = new SaveTracker();
    t.sent(1);
    t.sent(2);
    t.resynced();
    t.saved(3);
    expect(t.state(4)).toEqual({ kind: 'clean', savedAt: 3 });
    t.changed(false, 5);
    t.reset();
    expect(t.state(6)).toEqual({ kind: 'clean', savedAt: null });
  });
});

describe('labels', () => {
  it('formats the save indicator', () => {
    const at = Date.UTC(2026, 9, 9, 1, 3, 22);
    expect(formatClockTime(at, 'UTC')).toBe('01:03:22');
    expect(saveLabel({ kind: 'clean', savedAt: at }, 'Pacific/Auckland')).toBe('Saved 14:03:22');
    expect(saveLabel({ kind: 'clean', savedAt: null })).toBe('No unsaved changes');
    expect(saveLabel({ kind: 'dirty', since: 0, overdue: false })).toBe('Unsaved…');
    expect(saveLabel({ kind: 'dirty', since: 0, overdue: true })).toBe('Not saved yet');
  });

  it('summarises snapshots', () => {
    const at = Date.UTC(2026, 9, 9, 1, 3, 0);
    expect(snapshotSummary({ id: 'a', label: 'x', createdAt: at, layerCount: 1 }, 'UTC')).toMatch(/^1 layer · 9 Oct,? 01:03$/);
    expect(snapshotSummary({ id: 'a', label: 'x', createdAt: at, layerCount: 3 }, 'UTC')).toMatch(/^3 layers · /);
  });

  it('cleans snapshot labels', () => {
    expect(cleanSnapshotLabel('  before\n the   gig ')).toBe('before the gig');
    expect(cleanSnapshotLabel('x'.repeat(200))).toHaveLength(120);
  });
});

describe('project names', () => {
  it('validates new names', () => {
    expect(projectNameError('', [])).toMatch(/Enter/);
    expect(projectNameError(' leading', [])).toMatch(/letters/);
    expect(projectNameError('a/b', [])).toMatch(/letters/);
    expect(projectNameError('Demo', ['demo'])).toMatch(/already exists/);
    expect(projectNameError('Demo 2', ['demo'])).toBeNull();
  });

  it('suggests a free copy name', () => {
    expect(suggestCopyName('demo', ['demo'])).toBe('demo copy');
    expect(suggestCopyName('demo', ['demo', 'demo copy', 'Demo Copy 2'])).toBe('demo copy 3');
    expect(projectNameError(suggestCopyName('x'.repeat(64), []), [])).toBeNull();
  });

  it('spots project-changing patches', () => {
    expect(touchesProject([{ op: 'set', path: ['session', 'testPattern'], value: true }])).toBe(false);
    expect(touchesProject([{ op: 'set', path: ['profile', 'corners'], value: [] }])).toBe(false);
    expect(touchesProject([{ op: 'remove', path: ['project', 'parameters', 'x'] }])).toBe(true);
  });
});
