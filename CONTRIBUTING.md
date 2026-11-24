# Contributing to Asterhelm

Use a GitHub issue to report a bug or discuss a change. Include the operating system, component, Asterhelm version and a minimal reproduction using fictional data. For security reports, see [SECURITY.md](SECURITY.md).

1. Create a short-lived branch from the latest `main`. External contributors can use a fork.
2. Make a focused change. Include a regression test for a bug and update user documentation when behavior changes.
3. Run `npm test` with Node.js 24. For Android changes, run the host tests and build in [the Android guide](android/README.md).
4. Open a pull request against `main`. Explain the behavior change, link related issues and list the checks you ran. Use synthetic data for screenshots and logs.
5. Maintainers merge after CI passes. Follow-up fixes go through another pull request.

## Releases

The project follows semantic versioning. Patch releases fix compatible behavior, minor releases add compatible features and major releases introduce breaking changes to documented interfaces. Changes to pairing, configuration and stored data must describe the upgrade path.

For each release, update `package.json`, the Android version name and code, and [CHANGELOG.md](CHANGELOG.md) in a pull request. After it merges and CI passes, create an annotated `vMAJOR.MINOR.PATCH` tag on that commit and push the tag. GitHub Actions reruns both checks, verifies that the package and Android versions match the tag, and publishes the GitHub Release with its changelog entry. Keep existing release tags immutable.
