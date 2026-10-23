// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './helpers/mock-chat-controller-deps';
import { backendApi } from '../../src/ui/backend-client';
import {
  applyChunk,
  _resetTurnDurationTickerForTests,
  deleteMessageAndFollowing,
  dispatchWs,
  getMessages,
  renderChat,
} from '../../src/ui/features/chat-controller';
import { loadBackendHistory } from '../../src/ui/features/session-controller';
import { renderMessageHtml } from '../../src/ui/chat-render';
import { showConfirmDialog } from '../../src/ui/ui-feedback';
import { enqueuePending, getPendingQueue, state } from '../../src/ui/state';
import {
  __resetAllStoresForTest,
  messageStore,
  sessionStore,
  uiStore,
} from '../../src/ui/stores/stores';

vi.mock('../../src/ui/ui-feedback', () => ({ showConfirmDialog: vi.fn() }));
vi.mock('../../src/ui/features/workspaces', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/ui/features/workspaces')>(),
  refreshAllSessions: vi.fn(async () => {}),
  renderWorkspaceHistory: vi.fn(),
  getSessionAgentDisplay: vi.fn(() => null),
}));

const messages = [
  { id: 'u1', role: 'user' as const, content: '保留的问题', timestamp: 1000 },
  { id: 'a1', role: 'assistant' as const, content: '保留的回答', timestamp: 2000 },
  { id: 'u2', role: 'user' as const, content: '删除的问题', timestamp: 3000 },
  { id: 'a2', role: 'assistant' as const, content: '删除的回答', timestamp: 4000 },
  { id: 'u3', role: 'user' as const, content: '后续问题', timestamp: 5000 },
];

beforeEach(() => {
  __resetAllStoresForTest();
  sessionStore.set({ activeSessionId: 's1' });
  messageStore.set({ messages: { s1: [...messages], s2: [messages[0]] } });
  vi.mocked(showConfirmDialog).mockResolvedValue(true);
  vi.spyOn(backendApi, 'truncateHistory').mockResolvedValue({ ok: true });
  vi.spyOn(backendApi, 'sessions').mockResolvedValue([]);
  uiStore.set({
    backendConnected: true,
    socket: { send: vi.fn(async () => true), subscribe: vi.fn() } as never,
  });
  document.body.innerHTML = `
    <section id="welcome-panel"></section>
    <section id="chat-panel"><div id="chat-messages"></div></section>
  `;
});

afterEach(() => {
  _resetTurnDurationTickerForTests();
  vi.restoreAllMocks();
});

describe('deleting conversation history', () => {
  it('renders a trash control to the left of each user message, but not in previews', async () => {
    renderChat();
    const row = document.querySelector<HTMLElement>('[data-message-id="u2"]')!;
    const button = row.querySelector<HTMLButtonElement>('.chat-delete-btn')!;
    expect(row.firstElementChild).toBe(button);
    expect(button.getAttribute('aria-label')).toContain('删除本条及之后');
    expect(button.querySelector('use')?.getAttribute('href')).toBe('#icon-trash');
    expect(document.querySelector('[data-message-id="a1"] .chat-delete-btn')).toBeNull();
    expect(renderMessageHtml(messages[0], '', { preview: true, onDelete: vi.fn() })
      .querySelector('.chat-delete-btn')).toBeNull();
    button.click();
    await vi.waitFor(() => expect(backendApi.truncateHistory).toHaveBeenCalledWith('s1', 1, 3));
  });

  it('does not delete anything when confirmation is cancelled', async () => {
    vi.mocked(showConfirmDialog).mockResolvedValueOnce(false);
    await deleteMessageAndFollowing('s1', 'u2');
    expect(showConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      confirmText: '确认删除',
      message: expect.stringContaining('不可撤销'),
    }));
    expect(backendApi.truncateHistory).not.toHaveBeenCalled();
    expect(getMessages('s1')).toEqual(messages);
  });

  it('waits for persistence, removes the entire suffix, and continues from the retained prefix', async () => {
    let complete!: (value: { ok: boolean }) => void;
    vi.mocked(backendApi.truncateHistory).mockImplementationOnce(() => new Promise((resolve) => {
      complete = resolve;
    }));
    state.userFoldedTurns.add('a2');
    enqueuePending('s1', { id: 'queued', query: '旧的待发消息' });
    const deleting = deleteMessageAndFollowing('s1', 'u2');
    await vi.waitFor(() => expect(backendApi.truncateHistory).toHaveBeenCalled());
    expect(getMessages('s1')).toEqual(messages);
    expect(await dispatchWs('s1', '删除中不能发送')).toBe(false);
    complete({ ok: true });
    await deleting;
    expect(getMessages('s1')).toEqual(messages.slice(0, 2));
    expect(getMessages('s2')).toEqual([messages[0]]);
    expect(state.userFoldedTurns.has('a2')).toBe(false);
    expect(getPendingQueue('s1')).toEqual([]);
    applyChunk({ kind: 'final', session_id: 's1', body: { text: '迟到的回复' }, is_final: true });
    expect(getMessages('s1')).toEqual(messages.slice(0, 2));
    await dispatchWs('s1', '新的问题', []);
    expect(getMessages('s1').filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual(['保留的问题', '新的问题']);
  });

  it.each([false, true])('preserves messages and reports a backend failure (throws=%s)', async (throws) => {
    if (throws) vi.mocked(backendApi.truncateHistory).mockRejectedValueOnce(new Error('无法写入'));
    else vi.mocked(backendApi.truncateHistory).mockResolvedValueOnce({ ok: false });
    await deleteMessageAndFollowing('s1', 'u2');
    expect(getMessages('s1')).toEqual(messages);
    await vi.waitFor(() => expect(document.body.textContent).toContain('删除会话记录失败'));
    expect(state.suppressChunks.has('s1')).toBe(false);
  });

  it('can delete from the first user message and ignores duplicate clicks', async () => {
    const first = deleteMessageAndFollowing('s1', 'u1');
    await deleteMessageAndFollowing('s1', 'u1');
    await first;
    expect(backendApi.truncateHistory).toHaveBeenCalledTimes(1);
    expect(getMessages('s1')).toEqual([]);
  });

  it.each([false, true])('ignores stale in-flight history responses after deletion (rejects=%s)', async (rejects) => {
    let finishHistory!: () => void;
    vi.spyOn(backendApi, 'history').mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishHistory = () => rejects ? reject(new Error('旧请求失败')) : resolve([]);
    }));
    vi.spyOn(backendApi, 'sessionStatus').mockResolvedValue({
      session_id: 's1', live: 'idle', queue_depth: 0, last_status: 'idle', last_error: '',
    });
    vi.spyOn(backendApi, 'sessionPlan').mockResolvedValue({ has_plan: false, active: false });
    vi.spyOn(backendApi, 'sessionTodos').mockResolvedValue({ todos: [] });
    const loading = loadBackendHistory('s1');
    await deleteMessageAndFollowing('s1', 'u2');
    finishHistory();
    await loading;
    expect(getMessages('s1')).toEqual(messages.slice(0, 2));
  });
});
