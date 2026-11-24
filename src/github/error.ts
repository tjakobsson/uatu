// A refusal the /api/github/* routes turn into an HTTP status plus a short,
// user-facing message. Nothing else (stack, stderr, environment) reaches a
// client.
export class GithubError extends Error {
  constructor(readonly httpStatus: number, message: string) {
    super(message);
  }
}
