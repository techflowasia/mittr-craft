import { describe, expect, test } from 'bun:test';
import type { JsonValue } from '@openchamber/sdk';

import { createProjectFolderApi, type ProjectFolderFetch } from './projectFolderApi';
import { createProjectFolderNotice, type ProjectFolderOffer, type ProjectFolderOutcome } from './projectFolderNotice';

type Call = { path: string; body: JsonValue | undefined };

type Reply = { status: number; body: JsonValue | undefined };

const fakeFetch = (answer: (path: string) => Reply) => {
  const calls: Call[] = [];
  const fetchImpl: ProjectFolderFetch = async (path, init) => {
    calls.push({ path, body: init?.body ? JSON.parse(init.body) : undefined });
    const { status, body } = answer(path);
    return { ok: status >= 200 && status < 300, status, json: async () => body ?? null };
  };
  return { fetchImpl, calls };
};

const OFFER = { offer: true, files: ['agents/review.md', 'command/ship.md'] };

describe('the project folder api', () => {
  test('asks for the offer, copies and dismisses for one directory, by POST so the path stays out of the address', async () => {
    const { fetchImpl, calls } = fakeFetch((path): Reply => {
      if (path.endsWith('/status')) return { status: 200, body: OFFER };
      if (path.endsWith('/copy')) return { status: 200, body: { copied: ['command/ship.md'], skipped: ['agents/review.md'] } };
      return { status: 200, body: { answered: true } };
    });
    const api = createProjectFolderApi(fetchImpl);
    expect(await api.status('/work/app')).toEqual({ offer: true, files: ['agents/review.md', 'command/ship.md'] });
    expect(await api.copy('/work/app')).toEqual({ copied: ['command/ship.md'], skipped: ['agents/review.md'] });
    await api.dismiss('/work/app');
    expect(calls).toEqual([
      { path: '/api/mittr/project-folder/status', body: { directory: '/work/app' } },
      { path: '/api/mittr/project-folder/copy', body: { directory: '/work/app' } },
      { path: '/api/mittr/project-folder/dismiss', body: { directory: '/work/app' } },
    ]);
  });

  test('a refused, missing or malformed status is no offer, never an error', async () => {
    const replies: Reply[] = [{ status: 403, body: { error: 'no' } }, { status: 404, body: undefined }, { status: 200, body: { offer: 'yes' } }];
    for (const reply of replies) {
      const api = createProjectFolderApi(fakeFetch(() => reply).fetchImpl);
      expect(await api.status('/work/app')).toEqual({ offer: false, files: [] });
    }
    const failing = createProjectFolderApi(async () => { throw new Error('offline'); });
    expect(await failing.status('/work/app')).toEqual({ offer: false, files: [] });
  });

  test('a failed copy throws the server\'s reason', async () => {
    const api = createProjectFolderApi(fakeFetch((): Reply => ({ status: 409, body: { error: '.opencode in this project is not a folder MittrCraft can write into' } })).fetchImpl);
    await expect(api.copy('/work/app')).rejects.toThrow('.opencode in this project is not a folder MittrCraft can write into');
  });
});

const harness = (status: { offer: boolean; files: string[] } = OFFER) => {
  const offers: ProjectFolderOffer[] = [];
  const outcomes: ProjectFolderOutcome[] = [];
  const asked: string[] = [];
  const copied: string[] = [];
  const dismissed: string[] = [];
  const notice = createProjectFolderNotice({
    api: {
      status: async (directory) => {
        asked.push(directory);
        return status;
      },
      copy: async (directory) => {
        copied.push(directory);
        return { copied: ['command/ship.md'], skipped: ['agents/review.md'] };
      },
      dismiss: async (directory) => {
        dismissed.push(directory);
      },
    },
    offer: (offer) => offers.push(offer),
    report: (outcome) => outcomes.push(outcome),
  });
  return { notice, offers, outcomes, asked, copied, dismissed };
};

describe('the project folder notice', () => {
  test('offers once per project in a run, with the files .opencode lacks', async () => {
    const { notice, offers, asked } = harness();
    await notice.check('/work/app');
    await notice.check('/work/app');
    await notice.check(null);
    expect(asked).toEqual(['/work/app']);
    expect(offers.map((offer) => [offer.directory, offer.files])).toEqual([['/work/app', ['agents/review.md', 'command/ship.md']]]);
  });

  test('says nothing when there is nothing to copy', async () => {
    const { notice, offers } = harness({ offer: false, files: [] });
    await notice.check('/work/app');
    expect(offers).toEqual([]);
  });

  test('copy copies and reports what was copied and what was left alone', async () => {
    const { notice, offers, outcomes, copied } = harness();
    await notice.check('/work/app');
    await offers[0].copy();
    expect(copied).toEqual(['/work/app']);
    expect(outcomes).toEqual([{ kind: 'copied', copied: ['command/ship.md'], skipped: ['agents/review.md'] }]);
  });

  test('declining answers the notice for good', async () => {
    const { notice, offers, dismissed, outcomes } = harness();
    await notice.check('/work/app');
    await offers[0].dismiss();
    expect(dismissed).toEqual(['/work/app']);
    expect(outcomes).toEqual([]);
  });

  test('a failed copy reports its reason and leaves the notice to come back', async () => {
    const offers: ProjectFolderOffer[] = [];
    const outcomes: ProjectFolderOutcome[] = [];
    const notice = createProjectFolderNotice({
      api: { status: async () => OFFER, copy: async () => { throw new Error('No room'); }, dismiss: async () => {} },
      offer: (offer) => offers.push(offer),
      report: (outcome) => outcomes.push(outcome),
    });
    await notice.check('/work/app');
    await offers[0].copy();
    expect(outcomes).toEqual([{ kind: 'failed', reason: 'No room' }]);
  });
});
