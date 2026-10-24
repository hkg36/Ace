// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCallInfo } from '../../src/ui/chat-render';
import { renderSshHistory } from '../../src/ui/features/inspector-ssh';

function tool(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    toolCallId: 'ssh-1',
    name: 'ssh_exec',
    args: JSON.stringify({ profileId: 'server-1', command: 'pwd' }),
    result: JSON.stringify({ exitCode: 0, stdout: '/home/user\n', stderr: '' }),
    status: 'done',
    startedAt: 1000,
    ...overrides,
  };
}

function message(toolCalls: ToolCallInfo[], timestamp = 1000): ChatMessage {
  return { id: 'msg-1', role: 'assistant', content: '', timestamp, toolCalls };
}

function render(messages: ChatMessage[]): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = renderSshHistory(messages);
  return root;
}

describe('SSH inspector history', () => {
  it('filters unrelated tools and sorts all historical calls oldest first', () => {
    const root = render([
      message([tool({ toolCallId: 'latest', startedAt: 3000 })]),
      message([tool({ toolCallId: 'ignored', name: 'ssh_read_file' })]),
      message([tool({ toolCallId: 'first', startedAt: 0 }), tool({ toolCallId: 'second', startedAt: 2000 })]),
    ]);
    expect(Array.from(root.querySelectorAll('[data-ssh-call-id]'), (node) => node.getAttribute('data-ssh-call-id')))
      .toEqual(['first', 'second', 'latest']);
    expect(root.textContent).not.toContain('ignored');
    expect(root.querySelector('.inspector-ssh__command')?.textContent).toBe('pwd');
    expect(root.textContent).toContain('server-1');
  });

  it('shows stdout, stderr and non-zero exit codes without clipping or HTML injection', () => {
    const stdout = `<script>alert(1)</script>\n${'x'.repeat(5000)}\nend\n`;
    const root = render([message([tool({
      args: JSON.stringify({ profileId: '<b>server</b>', command: 'echo "<img src=x onerror=alert(1)>"' }),
      result: JSON.stringify({ exitCode: 2, stdout, stderr: 'permission denied\n' }),
    })])]);
    expect(root.querySelector('[aria-label="stdout"]')?.textContent).toBe(stdout);
    expect(root.querySelector('[aria-label="stderr"]')?.textContent).toBe('permission denied\n');
    expect(root.querySelector('[aria-label="exitCode"]')?.textContent).toBe('2');
    expect(root.querySelectorAll('[role="textbox"][aria-readonly="true"]')).toHaveLength(3);
    expect(root.textContent).toContain('permission denied\n');
    expect(root.textContent).toContain('<b>server</b>');
    expect(root.querySelectorAll('script, img, b')).toHaveLength(0);
  });

  it('shows pending, failed, empty and unstructured results explicitly', () => {
    expect(render([]).textContent).toContain('暂无 SSH 命令记录');
    expect(render([message([tool({ status: 'running', result: undefined })])]).textContent)
      .toContain('等待执行结果');
    expect(render([message([tool({ status: 'done', result: undefined })])]).textContent)
      .toContain('未记录返回结果');
    const emptyOutput = render([message([tool({ result: '{"exitCode":0,"stdout":"","stderr":" \\n"}' })])]);
    expect(emptyOutput.querySelectorAll('[role="textbox"]')).toHaveLength(1);
    expect(emptyOutput.querySelector('[aria-label="exitCode"]')?.textContent).toBe('0');
    expect(emptyOutput.querySelector('[aria-label="stdout"]')).toBeNull();
    expect(emptyOutput.querySelector('[aria-label="stderr"]')).toBeNull();
    expect(render([message([tool({ result: '{}' })])]).querySelector('.inspector-ssh__result')).toBeNull();
    expect(render([message([tool({ result: '' })])]).querySelector('.inspector-ssh__result')).toBeNull();
    const root = render([message([tool({
      args: '{"command":',
      result: 'SSH connection closed <error>',
      status: 'error',
    })])]);
    expect(root.textContent).toContain('执行失败');
    expect(root.textContent).toContain('{"command":');
    expect(root.textContent).toContain('SSH connection closed <error>');
    expect(root.querySelector('[aria-label="stderr"]')?.textContent).toBe('SSH connection closed <error>');
    const error = render([message([tool({ result: '{"error":"SSH operation timed out"}', status: 'error' })])]);
    expect(error.querySelector('[aria-label="stderr"]')?.textContent).toBe('SSH operation timed out');
    expect(error.textContent).not.toContain('{"error":');
  });
});
