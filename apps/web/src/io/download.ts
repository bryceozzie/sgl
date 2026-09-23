import type { SaveFile } from '../state/files.js';

/** DD-08 §7: "Blob download via a transient `<a download>`." (⟶ F3 swaps in
 *  `showSaveFilePicker` here, same call site.) */
export function downloadFile(file: SaveFile): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked on the next task, not synchronously: some engines start the
  // download asynchronously after the click and would find the URL gone.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
