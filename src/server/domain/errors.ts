/** Business-rule failure that maps to an HTTP status at the edge. */
export class DomainError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
  }
}

/** The agent's CLI is not installed. */
export class ProviderUnavailable extends Error {
  constructor(readonly label: string, readonly providerId: string) {
    super(`${label} not found`);
  }
}

/** The code host CLI (`gh`) is not installed. */
export class CodeHostUnavailable extends Error {
  constructor(readonly bin: string) {
    super(`${bin} not found`);
  }
}

export const notFound = (message: string) => new DomainError(message, 404);
export const badRequest = (message: string) => new DomainError(message, 400);
