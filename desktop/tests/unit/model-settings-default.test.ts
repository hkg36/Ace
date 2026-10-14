/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backendApi } from '../../src/ui/backend-client';
import { bindModelConfigModal, renderConfigModels } from '../../src/ui/features/config-panes';
import { __resetAllStoresForTest, configStore } from '../../src/ui/stores/stores';

const models = [
  { id: 'craft', name: 'Craft', model: 'craft', has_key: true, loaded: true },
  { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', has_key: true, loaded: true },
];

beforeEach(() => {
  vi.restoreAllMocks();
  __resetAllStoresForTest();
  document.body.innerHTML = `
    <section id="settings-pane-model"></section>
  `;
  configStore.set({
    config: {
      model: 'craft',
      has_key: true,
      base_url: '',
      active_model_id: 'craft',
      models,
    },
  });
});

describe('设置页默认模型切换', () => {
  it('调用全局模型接口并刷新默认模型状态', async () => {
    const switchSpy = vi.spyOn(backendApi, 'switchModel').mockResolvedValue({
      model: 'deepseek-chat',
      has_key: true,
      base_url: '',
      active_model_id: 'deepseek',
      models,
    });

    await renderConfigModels();
    expect(document.querySelector<HTMLButtonElement>('[data-integration-id="craft"] [data-integration-action="set-default"]')?.disabled).toBe(true);

    document.querySelector<HTMLButtonElement>('[data-integration-id="deepseek"] [data-integration-action="set-default"]')?.click();

    await vi.waitFor(() => {
      expect(switchSpy).toHaveBeenCalledWith('deepseek');
      expect(document.querySelector<HTMLButtonElement>('[data-integration-id="deepseek"] [data-integration-action="set-default"]')?.disabled).toBe(true);
      expect(document.querySelector<HTMLButtonElement>('[data-integration-id="craft"] [data-integration-action="set-default"]')?.disabled).toBe(false);
    });
  });
});

describe('新增模型对话框', () => {
  it('点击遮罩不会关闭，点击取消才会关闭', () => {
    document.body.innerHTML = `
      <div id="model-connect-overlay">
        <form id="cfg-model-form"></form>
        <button type="button" id="model-connect-close"></button>
        <button type="button" id="model-connect-cancel"></button>
        <button type="button" id="cfg-model-add"></button>
        <button type="button" id="cfg-model-delete"></button>
      </div>
    `;
    bindModelConfigModal();
    const overlay = document.getElementById('model-connect-overlay')!;

    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay.hidden).toBe(false);

    document.getElementById('model-connect-cancel')?.click();
    expect(overlay.hidden).toBe(true);
  });
});
