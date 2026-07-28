import { DomainError } from "../../src/shared/errors";
import { validateProviderConfig } from "../../src/providers/endpoint";

const BASE_CONFIG = {
  baseUrl: "http://remote.example/v1/",
  apiKey: "",
  model: "test",
  temperature: 0.2,
  maxOutputTokens: 500,
  timeoutMs: 5_000,
  allowInsecureRemote: false,
  allowedInsecureOrigin: "",
};

describe("endpoint security", () => {
  test("blocks cloud metadata endpoints", () => {
    expect(() =>
      validateProviderConfig({
        ...BASE_CONFIG,
        baseUrl: "http://169.254.169.254/v1/",
      }),
    ).toThrow(DomainError);
  });

  test("requires origin-scoped confirmation for remote HTTP", () => {
    expect(() => validateProviderConfig(BASE_CONFIG)).toThrow("requires explicit security confirmation");

    expect(() =>
      validateProviderConfig({
        ...BASE_CONFIG,
        allowInsecureRemote: true,
        allowedInsecureOrigin: "http://other.example:8080",
      }),
    ).toThrow("requires explicit security confirmation");

    expect(
      validateProviderConfig({
        ...BASE_CONFIG,
        allowInsecureRemote: true,
        allowedInsecureOrigin: "http://remote.example",
      }).baseUrl,
    ).toContain("remote.example");
  });
});
