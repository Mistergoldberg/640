import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readPublicFile(path: string) {
  return readFileSync(resolve(appRoot, path), "utf8");
}

describe("public Pixilation identity", () => {
  it("publishes canonical, social and structured metadata for the SPA root", () => {
    const html = readPublicFile("index.html");

    expect(html).toContain('<link rel="canonical" href="https://pixilation.org/">');
    expect(html).toContain('<meta property="og:url" content="https://pixilation.org/">');
    expect(html).toContain('"url":"https://pixilation.org/"');
    expect(html).toContain("<title>Pixilation</title>");
    expect(html).not.toContain("insertcatchytitlehere.com");
    expect(html).not.toMatch(/noindex/i);
  });

  it("allows crawling and points robots at the Pixilation sitemap", () => {
    const robots = readPublicFile("public/robots.txt");

    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Sitemap: https://pixilation.org/sitemap.xml");
    expect(robots).not.toMatch(/Disallow:\s*\//i);
    expect(robots).not.toContain("insertcatchytitlehere.com");
  });

  it("keeps the sitemap truthful for the static SPA indexing strategy", () => {
    const sitemap = readPublicFile("public/sitemap.xml");

    expect(sitemap).toContain("<loc>https://pixilation.org/</loc>");
    expect(sitemap).not.toContain("insertcatchytitlehere.com");
    expect(sitemap).not.toContain("?year=");
  });
});
