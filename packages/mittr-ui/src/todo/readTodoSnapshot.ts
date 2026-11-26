import { z } from 'zod';

import type { Message, Part, ToolPart } from '../../../ui/src/lib/opencode/model';
import { toolContentShellChars } from '../../../ui/src/lib/opencode/toolContentShells';

const todo = z.object({
  id: z.string().min(1),
  content: z.string().refine((value) => value.trim().length > 0),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
});

// The tools callback wraps action results before the plugin emits text content.
// A completed tool state alone does not prove that its action succeeded.
const writeResult = z.object({
  schemaVersion: z.literal(1),
  ok: z.literal(true),
  action: z.literal('todo.write'),
  data: z.object({ todos: z.array(todo) }),
});

export type TodoSnapshotItem = z.infer<typeof todo>;

export function isTodoWrite(part: Part): part is ToolPart {
  if (part.type !== 'tool' || part.tool !== 'mittrcraft_todo' || part.state.status !== 'completed') return false;
  return part.state.input.action === 'todo.write' || part.state.input.action === 'write';
}

export function todoSnapshotOf(part: Part): TodoSnapshotItem[] | null {
  if (!isTodoWrite(part) || part.state.status !== 'completed') return null;
  try {
    const parsed = writeResult.safeParse(JSON.parse(part.state.output));
    if (!parsed.success) return null;
    const todos = parsed.data.data.todos;
    if (new Set(todos.map((item) => item.id)).size !== todos.length) return null;
    return todos;
  } catch {
    return null;
  }
}

const carriesChecklist = (part: Part): part is ToolPart => (
  isTodoWrite(part) && (toolContentShellChars(part) !== null || todoSnapshotOf(part) !== null)
);

export function latestTodoWriteOf(parts: readonly Part[]): ToolPart | null {
  return [...parts].reverse().find(carriesChecklist) ?? null;
}

export function isChecklistReplaced(messageID: string, messages: readonly Message[], partsOf: (messageID: string) => readonly Part[]): boolean {
  const at = messages.findIndex((message) => message.id === messageID);
  if (at < 0) return false;
  for (const message of messages.slice(at + 1)) {
    if (message.role === 'user') return false;
    if (latestTodoWriteOf(partsOf(message.id))) return true;
  }
  return false;
}
