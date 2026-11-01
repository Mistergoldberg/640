export default class AcceptanceReporter {
  constructor(options = {}) {
    this.profile = options.profile || process.env.PIXILATION_ACCEPTANCE_PROFILE || "unspecified";
    this.counts = { passed: 0, failed: 0, skipped: 0 };
  }

  onTestEnd(_test, result) {
    if (result.status === "passed") this.counts.passed += 1;
    else if (result.status === "skipped") this.counts.skipped += 1;
    else this.counts.failed += 1;
  }

  onEnd(result) {
    const summary = { profile: this.profile, ...this.counts };
    process.stdout.write(`PIXILATION_ACCEPTANCE_SUMMARY ${JSON.stringify(summary)}\n`);
    if (this.counts.passed === 0 || this.counts.skipped > 0) return { status: "failed" };
    return { status: result.status };
  }
}
