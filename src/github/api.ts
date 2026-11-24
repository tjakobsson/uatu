// Reads GitHub's answers off the transport (src/github/gh.ts): a REST body or
// GraphQL `data`, or a classified GitHubFailure (src/github/classify.ts).
//
// GraphQL may answer with data *and* errors (a FORBIDDEN on one field, such as
// checks a fine-grained token can't read). That partial answer is kept: the
// errors travel with the data, and each adapter turns the ones under its
// section's path into "that section is unavailable" instead of failing the
// whole view. A rate limit is never partial.

import {
  classifyGraphqlError,
  classifyHttp,
  GitHubFailure,
  graphqlErrors,
  type GitHubResponse,
  type GraphqlError,
} from "./classify";
import type { GitHubTransport } from "./gh";

export type GraphqlOperation = { name: string; query: string; write?: boolean };

export type GraphqlAnswer<T> = { data: T; errors: GraphqlError[]; response: GitHubResponse };

export class GitHubApi {
  constructor(readonly transport: GitHubTransport, private readonly now: () => number = Date.now) {}

  async graphql<T>(host: string, operation: GraphqlOperation, variables: Record<string, unknown>): Promise<GraphqlAnswer<T>> {
    const response = await this.transport.request({
      kind: "graphql",
      host,
      operation: operation.name,
      query: operation.query,
      variables,
      ...(operation.write ? { write: true } : {}),
    });
    const httpFailure = classifyHttp(response, this.now(), operation.name);
    if (httpFailure) throw httpFailure;
    const errors = graphqlErrors(response.json);
    const data = (response.json as { data?: unknown } | null)?.data;
    const limited = errors.find(error => error.type === "RATE_LIMITED");
    if (limited) throw classifyGraphqlError(limited, response, this.now(), operation.name);
    if (data === null || data === undefined || typeof data !== "object") {
      if (errors[0]) throw classifyGraphqlError(errors[0], response, this.now(), operation.name);
      throw new GitHubFailure("unavailable", "GitHub's answer had no data.", { operation: operation.name, httpStatus: response.status });
    }
    return { data: data as T, errors, response };
  }

  async rest<T>(host: string, operation: string, path: string): Promise<{ json: T; headers: Record<string, string> }> {
    const response = await this.transport.request({ kind: "rest", host, operation, path });
    const failure = classifyHttp(response, this.now(), operation);
    if (failure) throw failure;
    return { json: response.json as T, headers: response.headers };
  }

  // The failure behind a section of a partial answer: the first error whose
  // path starts with `prefix` (field names; list indexes are skipped).
  sectionFailure(answer: GraphqlAnswer<unknown>, prefix: string[]): GitHubFailure | null {
    const error = answer.errors.find(candidate => {
      const names = (candidate.path ?? []).filter((part): part is string => typeof part === "string");
      return prefix.every((part, index) => names[index] === part);
    });
    return error ? classifyGraphqlError(error, answer.response, this.now()) : null;
  }
}
