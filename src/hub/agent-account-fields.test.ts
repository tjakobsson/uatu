import { describe, expect, test } from "bun:test";

import {
  AccountFieldError,
  collectAnswers,
  fieldVisible,
  fieldsFromOpenCodeV1Prompts,
  fieldsFromOpenCodeV2Form,
  stringAnswers,
} from "./agent-account-fields";

// Payloads as OpenCode 1.18.34's `GET /provider/auth` answered them on 2026-10-03.
const V1_COPILOT_PROMPTS = [
  {
    type: "select",
    key: "deploymentType",
    message: "Select GitHub deployment type",
    options: [
      { label: "GitHub.com", value: "github.com", hint: "Public" },
      { label: "GitHub Enterprise", value: "enterprise", hint: "Data residency or self-hosted" },
    ],
  },
  {
    type: "text",
    key: "enterpriseUrl",
    message: "Enter your GitHub Enterprise URL or domain",
    placeholder: "company.ghe.com or https://company.ghe.com",
    when: { key: "deploymentType", op: "eq", value: "enterprise" },
  },
];
const V1_GITLAB_PROMPTS = [{ type: "text", key: "instanceUrl", message: "GitLab instance URL", placeholder: "https://gitlab.com" }];
const V1_CLOUDFLARE_PROMPTS = [{ type: "text", key: "accountId", message: "Enter your Cloudflare Account ID", placeholder: "e.g. 1234567890abcdef1234567890abcdef" }];

// As OpenCode 2.0.13's `integration.list` answered for github-copilot's device method.
const V2_COPILOT_FORM = [
  {
    key: "deploymentType",
    title: "Select GitHub deployment type",
    required: true,
    type: "string",
    options: [
      { value: "github.com", label: "GitHub.com", description: "Public" },
      { value: "enterprise", label: "GitHub Enterprise", description: "Data residency or self-hosted" },
    ],
  },
  {
    key: "enterpriseUrl",
    title: "Enter your GitHub Enterprise URL or domain",
    required: true,
    type: "string",
    placeholder: "company.ghe.com",
    when: [{ key: "deploymentType", op: "eq", value: "enterprise" }],
  },
];

describe("OpenCode 1.x prompts", () => {
  test("a select with a conditional text field keeps both, the condition, and the hints", () => {
    const fields = fieldsFromOpenCodeV1Prompts(V1_COPILOT_PROMPTS);
    expect(fields).toEqual([
      {
        key: "deploymentType",
        label: "Select GitHub deployment type",
        kind: "select",
        valueType: "string",
        required: true,
        options: [
          { value: "github.com", label: "GitHub.com", hint: "Public" },
          { value: "enterprise", label: "GitHub Enterprise", hint: "Data residency or self-hosted" },
        ],
      },
      {
        key: "enterpriseUrl",
        label: "Enter your GitHub Enterprise URL or domain",
        kind: "text",
        valueType: "string",
        required: true,
        placeholder: "company.ghe.com or https://company.ghe.com",
        when: [{ key: "deploymentType", op: "eq", value: "enterprise" }],
      },
    ]);
  });

  test("GitLab's instance URL and Cloudflare's account id are plain text fields", () => {
    expect(fieldsFromOpenCodeV1Prompts(V1_GITLAB_PROMPTS)).toEqual([
      { key: "instanceUrl", label: "GitLab instance URL", kind: "text", valueType: "string", required: true, placeholder: "https://gitlab.com" },
    ]);
    expect(fieldsFromOpenCodeV1Prompts(V1_CLOUDFLARE_PROMPTS)[0]?.label).toBe("Enter your Cloudflare Account ID");
  });

  test("an unknown prompt type falls back to text instead of hiding the method", () => {
    expect(fieldsFromOpenCodeV1Prompts([{ type: "color", key: "theme", message: "Theme" }])).toEqual([
      { key: "theme", label: "Theme", kind: "text", valueType: "string", required: true },
    ]);
  });

  test("a sensitive prompt is a masked text field", () => {
    expect(fieldsFromOpenCodeV1Prompts([
      { type: "password", key: "pass", message: "Password" },
      { type: "secret", key: "token", message: "Token" },
      { type: "text", key: "pin", message: "PIN", sensitive: true },
      { type: "text", key: "account", message: "Account" },
    ]).map(field => [field.key, field.kind, field.secret ?? false])).toEqual([
      ["pass", "text", true],
      ["token", "text", true],
      ["pin", "text", true],
      ["account", "text", false],
    ]);
  });

  test("malformed entries are skipped and absent prompts are no fields", () => {
    expect(fieldsFromOpenCodeV1Prompts([null, 3, { type: "text" }, { key: "" }])).toEqual([]);
    expect(fieldsFromOpenCodeV1Prompts(undefined)).toEqual([]);
  });
});

describe("OpenCode 2.x form", () => {
  test("a sensitive string field is masked; a select never is", () => {
    expect(fieldsFromOpenCodeV2Form([
      { type: "string", key: "pass", title: "Password", format: "password", required: true },
      { type: "password", key: "token", title: "Token" },
      { type: "string", key: "region", title: "Region", secret: true, options: [{ value: "eu", label: "EU" }] },
      { type: "string", key: "account", title: "Account" },
    ]).map(field => [field.key, field.kind, field.secret ?? false])).toEqual([
      ["pass", "text", true],
      ["token", "text", true],
      ["region", "select", false],
      ["account", "text", false],
    ]);
  });

  test("Copilot's form maps to the same fields as 1.x prompts", () => {
    const fields = fieldsFromOpenCodeV2Form(V2_COPILOT_FORM);
    expect(fields.map(field => [field.key, field.kind, field.required, field.when])).toEqual([
      ["deploymentType", "select", true, undefined],
      ["enterpriseUrl", "text", true, [{ key: "deploymentType", op: "eq", value: "enterprise" }]],
    ]);
    expect(fields[0]?.options?.[1]).toEqual({ value: "enterprise", label: "GitHub Enterprise", hint: "Data residency or self-hosted" });
  });

  test("typed fields keep their value type and hidden or external fields are dropped", () => {
    const fields = fieldsFromOpenCodeV2Form([
      { key: "port", type: "integer", title: "Port" },
      { key: "beta", type: "boolean", title: "Use beta" },
      { key: "regions", type: "multiselect", title: "Regions", options: [{ value: "eu", label: "EU" }] },
      { key: "free", type: "string", title: "Model", options: [{ value: "a", label: "A" }], custom: true },
      { key: "internal", type: "string", hidden: true },
      { key: "docs", type: "external", url: "https://example.test" },
    ]);
    expect(fields.map(field => [field.key, field.kind, field.valueType])).toEqual([
      ["port", "text", "number"],
      ["beta", "select", "boolean"],
      ["regions", "text", "list"],
      ["free", "text", "string"],
    ]);
  });
});

describe("answers", () => {
  const fields = fieldsFromOpenCodeV1Prompts(V1_COPILOT_PROMPTS);

  test("a conditional field shows only for its answer", () => {
    expect(fieldVisible(fields[1]!, { deploymentType: "github.com" })).toBe(false);
    expect(fieldVisible(fields[1]!, { deploymentType: "enterprise" })).toBe(true);
  });

  test("a hidden field is not submitted even when a value was typed into it", () => {
    expect(collectAnswers(fields, { deploymentType: "github.com", enterpriseUrl: "left.over" })).toEqual({ deploymentType: "github.com" });
  });

  test("a visible required field without an answer names the field, not a value", () => {
    try {
      collectAnswers(fields, { deploymentType: "enterprise" });
      throw new Error("expected a field error");
    } catch (error) {
      expect(error).toBeInstanceOf(AccountFieldError);
      expect((error as AccountFieldError).field).toBe("enterpriseUrl");
    }
  });

  test("a select answer outside its options is refused", () => {
    expect(() => collectAnswers(fields, { deploymentType: "elsewhere" })).toThrow(AccountFieldError);
  });

  test("typed answers are converted, and 1.x receives strings", () => {
    const typed = fieldsFromOpenCodeV2Form([
      { key: "port", type: "integer", title: "Port", required: true },
      { key: "beta", type: "boolean", title: "Use beta" },
      { key: "regions", type: "multiselect", title: "Regions", options: [] },
    ]);
    const answers = collectAnswers(typed, { port: "8080", beta: "true", regions: "eu, us ,," });
    expect(answers).toEqual({ port: 8080, beta: true, regions: ["eu", "us"] });
    expect(stringAnswers(answers)).toEqual({ port: "8080", beta: "true", regions: "eu,us" });
    expect(() => collectAnswers(typed, { port: "eighty" })).toThrow(AccountFieldError);
  });
});
