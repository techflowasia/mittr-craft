import { productComposerShiftEnter, type ComposerEdit } from '@/lib/product-plugins';
import { shouldSubmitEnter, type EnterKeyPolicyInput } from './keyboardPolicy';

export type ShiftEnterInput = EnterKeyPolicyInput & {
    key: string;
    altKey: boolean;
    inputMode: string;
    autocompleteOpen: boolean;
    text: string;
    selectionStart: number;
    selectionEnd: number;
};

export const shiftEnterEdit = (input: ShiftEnterInput): ComposerEdit | null => {
    if (input.key !== 'Enter' || !input.shiftKey || input.altKey || input.ctrlKey || input.metaKey) return null;
    if (input.inputMode !== 'normal' || input.autocompleteOpen) return null;
    if (shouldSubmitEnter(input)) return null;
    return productComposerShiftEnter({ text: input.text, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd });
};
