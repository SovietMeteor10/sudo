export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}
