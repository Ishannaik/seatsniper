/** Shared provider error without loading BookMyShow's native TLS transport. */
export type ProviderErrorKind = "network" | "blocked" | "unparseable" | "bad_url" | "not_found";

export class BmsError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "BmsError";
  }
}
