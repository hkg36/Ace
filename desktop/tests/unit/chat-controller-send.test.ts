/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 共享 mock 必须先于 chat-controller 加载，见 helpers/mock-chat-controller-deps.ts
import './helpers/mock-chat-controller-deps';
import { _resetQueueEditDraftForTests, _resetTurnDurationTickerForTests, applyChunk, dispatchWs, editQueueItem, isRetryableError, renderChat, retryFailedOperation, sendMessage } from '../../src/ui/features/chat-controller';
import { loadBackendHistory } from '../../src/ui/features/session-controller';
import { backendApi } from '../../src/ui/backend-client';
import { enqueuePending, getPendingQueue } from '../../src/ui/state';
import { __resetAllStoresForTest, configStore, messageStore, sessionStore, uiStore, workspaceStore } from '../../src/ui/stores/stores';

vi.mock('../../src/ui/features/session-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/features/session-model')>();
  return {
    ...actual,
    persistDraftSessionModel: vi.fn(async () => undefined),
  };
});
beforeEach(() => {
  __resetAllStoresForTest();
  _resetQueueEditDraftForTests();
  const localStorageStub = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: localStorageStub,
  });
  vi.stubGlobal('localStorage', localStorageStub);
  configStore.set({ configModel: 'test-model' });
  vi.spyOn(backendApi, 'sessions').mockImplementation(async () => []);
  workspaceStore.set({
    currentWorkspaceId: 'default',
    workspaces: [{ id: 'default', name: '对话', description: '', instructions: '' }],
  });
  uiStore.set({
    backendConnected: true,
    socket: {
      send: vi.fn(async () => true),
      planEnter: vi.fn(async () => true),
      subscribe: vi.fn(),
    } as never,
  });
  document.body.innerHTML = `
    <div id="history-list"></div>
    <section id="welcome-panel"></section>
    <section id="chat-panel" hidden>
      <div id="chat-messages"></div>
      <div class="chat-queue-slot"></div>
      <div id="composer-controls"></div>
      <div class="chat-running-intro"></div>
      <textarea data-composer-input></textarea>
    </section>
  `;
});

afterEach(() => {
  _resetTurnDurationTickerForTests();
  vi.restoreAllMocks();
});

describe('sendMessage', () => {
  it.each(['网络连接失败', 'API key 无效（401）'])('shows a working retry button when the first request fails: %s', async (error) => {
    await sendMessage('你好');
    const sessionId = sessionStore.get().activeSessionId!;
    const socket = uiStore.get().socket!;
    const send = vi.mocked(socket.send);
    const payload = send.mock.calls.at(-1)![0];
    expect(payload).toHaveProperty('request_id');

    applyChunk({
      kind: 'error',
      session_id: sessionId,
      request_id: 'request_id' in payload ? payload.request_id : undefined,
      body: { message: error },
      sequence: 1,
      is_final: true,
    });

    const retry = document.querySelector<HTMLButtonElement>('.process-timeline__retry');
    expect(retry).not.toBeNull();
    expect(retry?.closest('details')).toBeNull();
    retry!.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.at(-1)![0]).toMatchObject({ query: '你好', session_id: sessionId });
    expect(messageStore.get().messages[sessionId].filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('keeps retry available after a retried request fails again without a request id', async () => {
    await sendMessage('再试一次');
    const sessionId = sessionStore.get().activeSessionId!;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      applyChunk({
        kind: 'error', session_id: sessionId,
        body: { message: '网络连接失败' }, sequence: 1, is_final: true,
      });
      const errorMessage = messageStore.get().messages[sessionId].at(-1)!;
      expect(isRetryableError(sessionId, errorMessage.id)).toBe(true);
      expect(await retryFailedOperation(sessionId, errorMessage.id)).toBe(true);
    }
    expect(messageStore.get().messages[sessionId].filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('shows retry when the socket cannot send the first message', async () => {
    vi.mocked(uiStore.get().socket!.send).mockResolvedValueOnce(false);
    await sendMessage('你好');
    const retry = document.querySelector<HTMLButtonElement>('.process-timeline__retry');
    expect(retry).not.toBeNull();
    retry!.click();
    await vi.waitFor(() => expect(uiStore.get().socket!.send).toHaveBeenCalledTimes(2));
  });

  it.each([
    { cached: false, empty: false },
    { cached: true, empty: false },
    { cached: true, empty: true },
  ])('restores retry for a failed first turn from history ($cached cached, $empty empty)', async ({ cached, empty }) => {
    sessionStore.set({ activeSessionId: 'sid-history-retry' });
    const sessionId = 'sid-history-retry';
    const attachments = [{ id: 'att-0', name: 'input.txt', path: 'D:\\input.txt', type: 'file' as const }];
    if (cached) {
      await dispatchWs(sessionId, '分析附件', attachments, {
        subScenario: 'test-scenario', planActive: true, workDisabledPreferenceIds: ['preference-1'],
      });
      applyChunk({
        kind: 'error', session_id: sessionId,
        body: { message: 'API key 无效' }, sequence: 1, is_final: true,
      });
    }
    vi.spyOn(backendApi, 'history').mockResolvedValue(empty ? [] : [
      { role: 'user', content: '分析附件\n附件「input.txt」位于：D:\\input.txt' },
    ]);
    vi.spyOn(backendApi, 'sessionStatus').mockResolvedValue({
      session_id: sessionId, live: 'idle', queue_depth: 0,
      last_status: 'failed', last_error: 'API key 无效',
    });
    vi.spyOn(backendApi, 'sessionPlan').mockResolvedValue({ has_plan: false, active: false });
    vi.spyOn(backendApi, 'sessionTodos').mockResolvedValue({ todos: [] });

    await loadBackendHistory(sessionId);
    renderChat();
    const retry = document.querySelector<HTMLButtonElement>('.process-timeline__retry');
    expect(retry).not.toBeNull();
    const send = vi.mocked(uiStore.get().socket!.send);
    const previousCalls = send.mock.calls.length;
    retry!.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(previousCalls + 1));
    expect(send.mock.calls.at(-1)![0]).toMatchObject({
      query: '分析附件', session_id: sessionId, attachments,
      ...(cached ? { sub_scenario: 'test-scenario', plan_active: true, work_disabled_preference_ids: ['preference-1'] } : {}),
    });
    expect(messageStore.get().messages[sessionId].filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('retries a later failed turn without repeating the previous successful request', async () => {
    await sendMessage('第一轮');
    const sessionId = sessionStore.get().activeSessionId!;
    applyChunk({
      kind: 'final', session_id: sessionId,
      body: { text: '第一轮完成' }, sequence: 1, is_final: true,
    });
    await sendMessage('第二轮');
    applyChunk({
      kind: 'error', session_id: sessionId,
      body: { message: 'API key 无效' }, sequence: 1, is_final: true,
    });
    const errorMessage = messageStore.get().messages[sessionId].at(-1)!;
    expect(await retryFailedOperation('another-session', errorMessage.id)).toBe(false);
    expect(await retryFailedOperation(sessionId, errorMessage.id)).toBe(true);
    const send = vi.mocked(uiStore.get().socket!.send);
    expect(send.mock.calls.at(-1)![0]).toMatchObject({ query: '第二轮', session_id: sessionId });
    expect(messageStore.get().messages[sessionId].filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual(['第一轮', '第二轮']);
    expect(await retryFailedOperation(sessionId, errorMessage.id)).toBe(false);
  });

  it('renders the first message immediately when no session is active', async () => {
    sendMessage('你好');
    await vi.waitFor(() => {
      const sessionId = sessionStore.get().activeSessionId;
      expect(messageStore.get().messages[sessionId!]?.[0]?.content).toBe('你好');
    });
    const sessionId = sessionStore.get().activeSessionId;
    expect(sessionId).toBeTruthy();
    expect((document.getElementById('chat-panel') as HTMLElement).hidden).toBe(false);
    expect(document.getElementById('chat-messages')?.textContent).toContain('你好');
  });

  it('moves an edited pending message to the queue tail when resubmitted while busy', () => {
    sessionStore.set({
      activeSessionId: 'sid-1',
      busySessions: { 'sid-1': true },
      sessions: [{ id: 'sid-1', title: '对话', preview: '', updatedAt: 0, workspaceId: 'default' }] as never,
    });
    enqueuePending('sid-1', { id: 'a', query: '第一条', attachments: [] });
    enqueuePending('sid-1', { id: 'b', query: '第二条', attachments: [] });
    enqueuePending('sid-1', { id: 'c', query: '第三条', attachments: [] });
    enqueuePending('sid-1', { id: 'd', query: '第四条', attachments: [] });

    editQueueItem('sid-1', 2);
    expect(getPendingQueue('sid-1').map((item) => item.query)).toEqual(['第一条', '第二条', '第四条']);

    sendMessage('第三条-修改后');

    expect(getPendingQueue('sid-1').map((item) => item.query)).toEqual([
      '第一条',
      '第二条',
      '第四条',
      '第三条-修改后',
    ]);
    // 入队（busy 时发送，即「引导/待发」卡片的来源）不应改写会话标题：
    // 标题由首条消息决定，待发消息不得抢占。回归 issue 4：标题不再变成 steer/排队内容。
    const enqueued = sessionStore.get().sessions.find((s) => s.id === 'sid-1');
    expect(enqueued?.title).toBe('对话');
  });

  it('sends plan_active when composer is in Plan mode', async () => {
    configStore.set({ composerMode: 'plan' });

    sendMessage('先规划');

    await vi.waitFor(() => {
      const socket = uiStore.get().socket as unknown as { send: ReturnType<typeof vi.fn> };
      expect(socket.send).toHaveBeenCalled();
    });

    const socket = uiStore.get().socket as unknown as { send: ReturnType<typeof vi.fn>; planEnter: ReturnType<typeof vi.fn> };
    expect(socket.planEnter).toHaveBeenCalled();
    expect(socket.send.mock.calls.at(-1)?.[0]).toMatchObject({
      query: '先规划',
      plan_active: true,
    });
  });

  it('uses the queued message plan flag instead of the current composer mode', async () => {
    configStore.set({ composerMode: 'plan' });

    await dispatchWs('sid-queued', '按普通模式发送', [], '', false);

    const socket = uiStore.get().socket as unknown as { send: ReturnType<typeof vi.fn>; planEnter: ReturnType<typeof vi.fn> };
    expect(socket.planEnter).not.toHaveBeenCalled();
    expect(socket.send.mock.calls.at(-1)?.[0]).toMatchObject({
      query: '按普通模式发送',
    });
    expect(socket.send.mock.calls.at(-1)?.[0]).not.toHaveProperty('plan_active');
  });
});
