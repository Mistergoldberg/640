import process from "node:process";

const operation = process.argv[2] || "publication";
const messages = {
  import: "The in-repository legacy importer is retired because it emits the pre-cv1 media contract.",
  "sample-import": "The legacy sample importer is retired; it cannot write canonical or publication-eligible output.",
  upload: "The broad legacy R2 uploader is retired and cannot plan or publish media."
};

process.stderr.write(
  `${messages[operation] || messages.import} ` +
  "Use the package-bound workflow in the separately controlled pixilation-import-plan repository; " +
  "see docs/publication-authority.md.\n"
);
process.exitCode = 2;
