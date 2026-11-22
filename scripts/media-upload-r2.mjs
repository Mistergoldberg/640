import process from "node:process";

process.stderr.write(
  "Retired broad uploader: media publication must consume a sealed, approved package through " +
  "the package-bound pixilation-import-plan workflow documented in docs/publication-authority.md.\n"
);
process.exitCode = 2;
