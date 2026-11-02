# Project agent guide

## Project context

This is a browser-only React, TypeScript, and Vite application. See [architecture](docs/architecture.md) for the approved first-slice decisions.

## Ownership

- Frontend engineers own the workspace UI and its component tests.
- Domain engineers own `src/domain/**` and domain tests.
- Audio engineers own `src/audio/**` and audio tests.
- QA verifies integrated journeys and records reproducible evidence; reviewers independently inspect the diff and evidence.
- Documentation work owns documentation changes.

Keep module boundaries clear. Ask the owning role for a contract change instead of duplicating its implementation. For routine work with clear ownership, route directly to that engineer without a separate planning layer.

## Engineering guidance

- Make the smallest coherent change that satisfies the requirement.
- Validate user-provided files at the import boundary and keep browser APIs out of pure domain logic.
- Keep tests deterministic, local, and free of live credentials or external-service dependencies.
- Run the narrowest relevant checks and report the exact evidence and any remaining gap.
- Avoid unrelated formatting, dependency updates, and cleanup.
- Review the diff and relevant evidence independently before release.

## Pull requests and publication

- `@FreshPete` is the sole code owner and approval authority for this repository.
- Publish future changes on a branch and open a pull request; do not push directly to `main`.
- Agents must not approve or merge pull requests, enable auto-merge, or use an owner bypass unless the user explicitly authorizes that action for the specific pull request. General implementation or deployment requests do not waive this policy.
- Keep code-owner requirements and branch rules intact. PRs authored using the owner's account need the owner's explicit merge/bypass decision because GitHub does not permit self-approval.
