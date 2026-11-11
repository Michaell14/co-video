import { describe, expect, it } from 'vitest';
import { eventKeys, type KeyStroke } from '../src/state/keys';

const stroke = (key: string, code: string, mods: Partial<KeyStroke> = {}): KeyStroke => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('eventKeys', () => {
  it('names plain, shifted and modified keys', () => {
    expect(eventKeys(stroke('s', 'KeyS'))).toBe('s');
    expect(eventKeys(stroke('Z', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toBe('mod+shift+z');
    expect(eventKeys(stroke('z', 'KeyZ', { metaKey: true }))).toBe('mod+z');
    expect(eventKeys(stroke(' ', 'Space'))).toBe('space');
    expect(eventKeys(stroke('ArrowLeft', 'ArrowLeft', { shiftKey: true }))).toBe('shift+arrowleft');
    expect(eventKeys(stroke('!', 'Digit1', { shiftKey: true }))).toBe('shift+1');
    expect(eventKeys(stroke('?', 'Slash', { shiftKey: true }))).toBe('shift+slash');
  });

  it('reads letters by position on layouts that do not type Latin ones', () => {
    // Russian: the Z key types "я", C types "с" (Cyrillic es), S types "ы".
    expect(eventKeys(stroke('я', 'KeyZ', { ctrlKey: true }))).toBe('mod+z');
    expect(eventKeys(stroke('Я', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toBe('mod+shift+z');
    expect(eventKeys(stroke('с', 'KeyC', { ctrlKey: true }))).toBe('mod+c');
    expect(eventKeys(stroke('ы', 'KeyS'))).toBe('s');
    // Greek, Hebrew, Arabic.
    expect(eventKeys(stroke('ς', 'KeyW'))).toBe('w');
    expect(eventKeys(stroke('ש', 'KeyA', { ctrlKey: true }))).toBe('mod+a');
    expect(eventKeys(stroke('ض', 'KeyQ'))).toBe('q');
  });

  it('reads punctuation by position when the layout prints a letter there', () => {
    expect(eventKeys(stroke('б', 'Comma'))).toBe('comma');
    expect(eventKeys(stroke('Ю', 'Period', { shiftKey: true }))).toBe('shift+period');
  });

  it('sees through the symbols Option produces on macOS', () => {
    expect(eventKeys(stroke('≈', 'KeyX', { altKey: true }))).toBe('alt+x');
    expect(eventKeys(stroke('ç', 'KeyC', { altKey: true, metaKey: true }))).toBe('mod+alt+c');
    expect(eventKeys(stroke('√', 'KeyV', { altKey: true, metaKey: true }))).toBe('mod+alt+v');
    expect(eventKeys(stroke('µ', 'KeyM', { altKey: true }))).toBe('alt+m');
    // Option+E is a dead key waiting for a vowel.
    expect(eventKeys(stroke('Dead', 'KeyE', { altKey: true }))).toBe('alt+e');
  });

  it('follows the printed letter on Latin layouts that move it', () => {
    // Dvorak: the key in the QWERTY "S" position types "o".
    expect(eventKeys(stroke('o', 'KeyS'))).toBe('o');
    // AZERTY: the key in the QWERTY "Q" position types "a", also with Alt held on Windows.
    expect(eventKeys(stroke('a', 'KeyQ', { ctrlKey: true }))).toBe('mod+a');
    expect(eventKeys(stroke('x', 'KeyX', { altKey: true }))).toBe('alt+x');
  });

  it('treats + as the zoom-in key with or without Shift', () => {
    expect(eventKeys(stroke('=', 'Equal'))).toBe('equal');
    expect(eventKeys(stroke('+', 'Equal', { shiftKey: true }))).toBe('shift+equal');
    expect(eventKeys(stroke('+', 'Equal', { shiftKey: true, ctrlKey: true }))).toBe('mod+shift+equal');
    expect(eventKeys(stroke('+', 'NumpadAdd'))).toBe('equal');
  });
});
