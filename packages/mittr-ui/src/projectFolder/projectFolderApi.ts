import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { errorTextOf, readJsonReply } from '../errorReply';
import { mittrT } from '../strings/mittrT';

const ENDPOINT = '/api/mittr/project-folder';

const statusPayload = z.object({ offer: z.boolean(), files: z.array(z.string()) });
const copyPayload = z.object({ copied: z.array(z.string()), skipped: z.array(z.string()) });

export type ProjectFolderStatus = z.output<typeof statusPayload>;
export type ProjectFolderCopy = z.output<typeof copyPayload>;

type ProjectFolderResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };

type ProjectFolderInit = { method: string; headers?: Record<string, string>; body?: string };

export type ProjectFolderFetch = (path: string, init?: ProjectFolderInit) => Promise<ProjectFolderResponse>;

export type ProjectFolderApi = {
  status(directory: string): Promise<ProjectFolderStatus>;
  copy(directory: string): Promise<ProjectFolderCopy>;
  dismiss(directory: string): Promise<void>;
};

const NO_OFFER: ProjectFolderStatus = { offer: false, files: [] };

export function createProjectFolderApi(fetchImpl: ProjectFolderFetch = runtimeFetch): ProjectFolderApi {
  const post = (verb: string, directory: string): Promise<ProjectFolderResponse> =>
    fetchImpl(`${ENDPOINT}/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory }) });

  return {
    status: async (directory) => {
      try {
        const response = await post('status', directory);
        if (!response.ok) return NO_OFFER;
        const parsed = statusPayload.safeParse(await readJsonReply(response));
        return parsed.success ? parsed.data : NO_OFFER;
      } catch {
        return NO_OFFER;
      }
    },
    copy: async (directory) => {
      const fallback = mittrT('mittr.projectFolder.failed');
      let response: ProjectFolderResponse;
      try {
        response = await post('copy', directory);
      } catch {
        throw new Error(fallback);
      }
      const body = await readJsonReply(response);
      if (!response.ok) throw new Error(errorTextOf(body, fallback));
      const parsed = copyPayload.safeParse(body);
      if (!parsed.success) throw new Error(fallback);
      return parsed.data;
    },
    dismiss: async (directory) => {
      try {
        await post('dismiss', directory);
      } catch {
        return;
      }
    },
  };
}
