import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

type PasswordContext = Pick<ContextMenuParams, 'formControlType' | 'isEditable'> & { editFlags: Pick<ContextMenuParams['editFlags'], 'canPaste'> };
/** Electron's native edit action targets the focused control without reading clipboard data into JS. */
export function passwordPasteMenu(eligible: boolean, params: PasswordContext): MenuItemConstructorOptions[] | undefined {
 if (eligible && params.isEditable && params.formControlType === 'input-password') {
  return [{ role: 'paste', label: '粘贴', ...(params.editFlags.canPaste ? {} : { enabled: false }) }];
 }
}
