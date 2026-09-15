/**
 * Skeleton marker. A stage that has not been built yet throws this rather than
 * returning a plausible-looking empty result, so an unimplemented stage can never
 * be mistaken for a stage that found nothing.
 *
 * This is a programming-error throw, which DD-00 §3 permits; it is not a
 * diagnostic, and every call site disappears as its stage lands.
 */
export class NotImplemented extends Error {
  constructor(what: string, designDoc: string) {
    super(`${what} is not implemented yet. Design: ${designDoc}.`);
    this.name = 'NotImplemented';
  }
}
