import type { SaveFile } from '../state/files.js';

/** DD-08 §7: "Blob download via a transient `<a download>`." (⟶ F3 swaps in
 *  `showSaveFilePicker` here, same call site.) */
export function downloadFile(file: SaveFile): void {
  downloadBlob(new Blob([file.text], { type: file.mime }), file.name);
}

/** The same, for content that is already a Blob (Save ▾ PNG, D6). */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked on the next task, not synchronously: some engines start the
  // download asynchronously after the click and would find the URL gone.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
