import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const stylesheet = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const baseStyles = stylesheet('../src/style.css');
const nookStyles = stylesheet('../src/pet-nook.css');
const moduleStyles = stylesheet('../src/pages/pages.css');
const interactionStyles = stylesheet('../src/pages/interaction-pages.css');
const modelStyles = stylesheet('../src/models.css');
const chatStyles = stylesheet('../src/chat.css');

test('text fields use a border focus state instead of an outline ring', () => {
  assert.match(baseStyles, /:is\(input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\), textarea\):focus-visible\s*\{\s*outline:\s*none;\s*border-color:\s*var\(--focus\);/);
  assert.match(baseStyles, /@media \(forced-colors: active\) \{\s*:is\(input[^}]+border-color:\s*var\(--system-focus\)/);
  assert.ok(moduleStyles.includes('.workspace-module :is(select, button, summary, [role="tabpanel"], input[type="checkbox"], input[type="radio"], input[type="range"]):focus-visible'));
  assert.ok(interactionStyles.includes('.interaction-page :focus-visible:not(:where(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, [contenteditable="true"]))'));
  assert.match(modelStyles, /\.model-field select:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus\);/);
  assert.match(chatStyles, /\.chat-draft-editor:focus-visible\s*\{[^}]*outline:\s*none;/);
  assert.match(chatStyles, /\.agent-task-body textarea:focus-visible\s*\{[^}]*outline:\s*none;/);
  assert.match(chatStyles, /\.agent-task-composer:focus-within\s*\{[^}]*border-color:\s*var\(--focus\);/);
});

test('chat composer uses its border, not a focus-within shadow ring', () => {
  const focusWithin = chatStyles.match(/\.chat-composer:focus-within\s*\{([^}]*)\}/)?.[1];
  assert.ok(focusWithin, 'chat composer keeps a focus-within border state');
  assert.match(focusWithin, /border-color:\s*var\(--focus\)/);
  assert.doesNotMatch(focusWithin, /box-shadow:/);
});

test('keyboard focus rings remain available to non-text controls', () => {
  assert.match(baseStyles, /:focus-visible\s*\{\s*outline:\s*3px solid var\(--focus\);/);
  assert.match(interactionStyles, /\.live-scene-option:has\(input:focus-visible\)\s*\{\s*outline:\s*2px solid var\(--focus\);/);
  assert.match(nookStyles, /\.pet-role-picker:has\(select:focus-visible\)\s*\{\s*outline:\s*2px solid var\(--focus\);/);
  assert.match(moduleStyles, /input\[type="checkbox"\]/);
});
