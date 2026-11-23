import assert from 'node:assert/strict';
import test from 'node:test';
import { modelReasoningLevels, validModelCapabilities } from '../src/model-capabilities.ts';

test('reasoning controls are limited to exact reviewed OpenAI Responses model identities', () => {
  assert.deepEqual(modelReasoningLevels({ protocol: 'responses', baseURL: 'https://api.openai.com/v1', modelID: 'gpt-6.2-astra' }),
    ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(modelReasoningLevels({ protocol: 'responses', baseURL: 'https://gateway.example/v1', modelID: 'gpt-6.2-astra' }), []);
  assert.deepEqual(modelReasoningLevels({ protocol: 'responses', baseURL: 'https://api.openai.com/v1', modelID: 'unknown-model' }), []);
  assert.deepEqual(modelReasoningLevels({ protocol: 'chat-completions', baseURL: 'https://api.openai.com/v1', modelID: 'gpt-6.2-astra' }), []);
});

test('saved model capabilities reject cross-protocol modalities and unsupported reasoning values', () => {
  assert.equal(validModelCapabilities({ protocol: 'responses', baseURL: 'https://api.openai.com/v1', modelID: 'gpt-6.2-astra',
    reasoningEffort: 'high', inputModalities: ['image', 'pdf'] }), true);
  assert.equal(validModelCapabilities({ protocol: 'responses', baseURL: 'https://api.openai.com/v1', modelID: 'gpt-6.2-astra',
    reasoningEffort: 'none' }), false);
  assert.equal(validModelCapabilities({ protocol: 'chat-completions', baseURL: 'https://api.openai.com/v1', modelID: 'gpt-6.2-astra',
    inputModalities: ['image'] }), false);
  assert.equal(validModelCapabilities({ protocol: 'responses', baseURL: 'https://api.openai.com/v1', modelID: 'gpt-6.2-astra',
    inputModalities: ['pdf'] }), false);
  assert.equal(validModelCapabilities({ protocol: 'responses', baseURL: 'https://api.openai.com/v1', modelID: 'gpt-6.2-astra',
    inputModalities: ['image', 'image'] }), false);
});

test('arbitrary model IDs cannot resolve Object prototype members as reasoning levels', () => {
  const endpoint = { protocol: 'responses', baseURL: 'https://api.openai.com/v1', modelID: 'constructor' } as const;
  assert.deepEqual(modelReasoningLevels(endpoint), []);
  assert.equal(validModelCapabilities({ ...endpoint, reasoningEffort: 'low' }), false);
});
