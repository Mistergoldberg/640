import { describe, expect, it } from "vitest";
import { resolveDeploymentConfig } from "./deploymentConfig";

describe("deployment configuration", () => {
  it("keeps local development at /640/ with local media", () => {
    expect(resolveDeploymentConfig("development", {})).toEqual({ base: "/640/", mediaBaseUrl: "" });
  });
  it("builds production for the apex and public R2 origin by default", () => {
    expect(resolveDeploymentConfig("production", {})).toEqual({
      base: "/", mediaBaseUrl: "https://media.insertcatchytitlehere.com/"
    });
  });
  it("accepts an explicit development base without changing media keys", () => {
    expect(resolveDeploymentConfig("development", { VITE_APP_BASE_PATH: "/preview/" }).base).toBe("/preview/");
  });
  it.each(["640/", "//example.com/", "/../", "/?year=2013", "/640"])("rejects unsafe or ambiguous base %s", (base) => {
    expect(() => resolveDeploymentConfig("production", { VITE_APP_BASE_PATH: base })).toThrow();
  });
  it.each(["http://media.example.com/", "https://user:password@media.example.com/", "https://media.example.com/?token=secret"])("rejects unsafe production media URL %s", (media) => {
    expect(() => resolveDeploymentConfig("production", { VITE_MEDIA_BASE_URL: media })).toThrow();
  });
});
