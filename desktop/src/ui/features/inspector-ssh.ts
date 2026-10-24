import type { ChatMessage, ToolCallInfo } from '../chat-render';
import { escapeHtml } from '../state';

function parseRecord(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function renderResult(tool: ToolCallInfo): string {
  if (tool.result === undefined) {
    const pending = tool.status === 'generating' || tool.status === 'running';
    return `<p class="inspector-ssh__hint">${pending ? '等待执行结果…' : '未记录返回结果'}</p>`;
  }
  const result = parseRecord(tool.result);
  if (result) {
    return [
      renderResultField('exitCode', typeof result.exitCode === 'number' ? String(result.exitCode) : ''),
      renderResultField('stdout', typeof result.stdout === 'string' ? result.stdout : ''),
      renderResultField('stderr', typeof result.stderr === 'string' && result.stderr.trim()
        ? result.stderr : typeof result.error === 'string' ? result.error : ''),
    ].join('');
  }
  return renderResultField(tool.status === 'error' ? 'stderr' : 'stdout', tool.result);
}

function renderResultField(name: 'exitCode' | 'stdout' | 'stderr', value: string): string {
  if (!value.trim()) return '';
  return `<div class="inspector-ssh__field">
    <div class="inspector-ssh__hint">${name}</div>
    <pre class="inspector-ssh__output" role="textbox" aria-label="${name}" aria-readonly="true" aria-multiline="true" tabindex="0">${escapeHtml(value)}</pre>
  </div>`;
}

const STATUS_LABELS: Record<ToolCallInfo['status'], string> = {
  generating: '准备中',
  running: '执行中',
  done: '已完成',
  error: '执行失败',
};

export function renderSshHistory(messages: readonly ChatMessage[]): string {
  const calls = messages.flatMap((message) => (message.toolCalls ?? [])
    .filter((tool) => tool.name === 'ssh_exec')
    .map((tool) => ({ tool, timestamp: tool.startedAt || message.timestamp })))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (calls.length === 0) {
    return '<div class="inspector-empty">当前对话暂无 SSH 命令记录</div>';
  }
  return `<section class="inspector-ssh" aria-label="SSH 命令历史">${calls.map(({ tool, timestamp }) => {
    const args = parseRecord(tool.args);
    const command = typeof args?.command === 'string' ? args.command : tool.args || '命令参数尚未生成';
    const profile = typeof args?.profileId === 'string' ? args.profileId : '';
    const result = renderResult(tool);
    return `<article class="inspector-ssh__entry" data-ssh-call-id="${escapeHtml(tool.toolCallId)}">
      <header class="inspector-ssh__head">
        <span>${escapeHtml(STATUS_LABELS[tool.status])}</span>
        ${profile ? `<span>${escapeHtml(profile)}</span>` : ''}
        <time>${escapeHtml(new Date(timestamp).toLocaleString('zh-CN', { hour12: false }))}</time>
      </header>
      <pre class="inspector-ssh__command">${escapeHtml(command)}</pre>
      ${result ? `<div class="inspector-ssh__result">${result}</div>` : ''}
    </article>`;
  }).join('')}</section>`;
}
