import { afterEach, describe, expect, it, vi } from 'vitest';

import { createContinuationReview } from './continuation-review.js';

const input = { sessionId: 'ses_1', directory: '/repo', goalId: 'goal_1', resumed: false };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('continuation review', () => {
  it('passes the reviewer\'s block and note on, trimmed', async () => {
    const review = createContinuationReview(async (asked) => ({ block: ` looping: ${asked.sessionId} `, note: ' change approach ' }));

    expect(await review(input)).toEqual({ block: 'looping: ses_1', note: 'change approach' });
  });

  it('asks nothing and changes nothing without a reviewer', async () => {
    expect(await createContinuationReview(null)(input)).toEqual({ block: '', note: '' });
  });

  it.each([
    ['throws', async () => { throw new Error('review broke'); }],
    ['answers with something that is not text', async () => ({ block: 42 })],
  ])('changes nothing when the reviewer %s', async (_label, reviewer) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await createContinuationReview(reviewer)(input)).toEqual({ block: '', note: '' });
    expect(warn).toHaveBeenCalledWith('[session-goal] continuation review failed:', expect.anything());
  });

  it('keeps one review per session: a timed-out review is not run alongside the next', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = [];
    const reviewer = vi.fn(() => new Promise((resolve) => { pending.push(resolve); }));
    const review = createContinuationReview(reviewer, 1_000);

    const first = review(input);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toEqual({ block: '', note: '' });
    expect(await review(input)).toEqual({ block: '', note: '' });
    expect(reviewer).toHaveBeenCalledTimes(1);
    const otherSession = review({ ...input, sessionId: 'ses_2' });
    expect(reviewer).toHaveBeenCalledTimes(2);

    pending[0]({ note: 'late' });
    await vi.advanceTimersByTimeAsync(0);
    reviewer.mockImplementation(async () => ({ note: 'fresh' }));
    expect(await review(input)).toEqual({ block: '', note: 'fresh' });
    expect(reviewer).toHaveBeenCalledTimes(3);
    pending[1]({});
    await otherSession;
  });

  it('gives up on a reviewer that never answers after the timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = createContinuationReview(() => new Promise(() => {}), 30_000)(input);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await pending).toEqual({ block: '', note: '' });
  });
});
