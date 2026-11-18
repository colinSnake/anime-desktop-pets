import type { ModelConfiguration, ModelProtocol } from '../../src/models/types.ts';
export const configuration = (apiProtocol: ModelProtocol = 'chat-completions'): ModelConfiguration => ({
  schemaVersion: 2, revision: 1, defaultConnectionID: 'connection-one', connections: [{
    id: 'connection-one', revision: 1, displayName: '合成连接', preset: 'custom', apiProtocol,
    baseURL: apiProtocol === 'gemini' ? 'https://synthetic.invalid/prefix/v1beta' : 'https://synthetic.invalid/prefix/v1',
    authMode: 'apiKey', credentialRef: 'credential-version-one', defaultModelEntryID: 'entry-one', compatibility: {},
    models: [{ entryID: 'entry-one', modelID: 'synthetic-model', displayName: '合成模型', capabilities: { tools: { status: 'unknown', source: 'user' } }, compatibility: {} }],
  }],
});
