/**
 * DD-08 §12: the manifest's `file_handlers` launch the installed app with a
 * `.sgl`/`.sgl.json` file; `window.launchQueue` delivers it, and this routes it
 * into the same Open path as the toolbar (§7). Chromium-only today; elsewhere
 * `launchQueue` is absent and this does nothing.
 */

interface LaunchParamsLike {
  readonly files: readonly { getFile(): Promise<File> }[];
}

interface LaunchQueueLike {
  setConsumer(consumer: (params: LaunchParamsLike) => void): void;
}

export function consumeLaunchQueue(open: (file: File) => void): void {
  const queue = (window as unknown as { launchQueue?: LaunchQueueLike }).launchQueue;
  if (queue === undefined) return;
  queue.setConsumer((params) => {
    // One document at a time (E17's drawer is later): the first file opens.
    const handle = params.files[0];
    if (handle === undefined) return;
    void handle.getFile().then(open, (err: unknown) => console.warn('[SGL] could not read the launched file.', err));
  });
}
