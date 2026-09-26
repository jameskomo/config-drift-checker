# Security policy

## Reporting a vulnerability

Email **progressoverperfection01@gmail.com** with "SECURITY" in the subject, or use GitHub's
[private vulnerability reporting](https://github.com/jameskomo/config-drift-checker/security/advisories/new)
on this repository. You will get an acknowledgement within 72 hours. Please do not open public
issues for vulnerabilities.

## Scope and posture

- Zero runtime dependencies: the tools import Node builtins only, so there is no npm supply chain
  to compromise. CodeQL runs on every push; Dependabot watches the Action pins.
- Every third-party GitHub Action is pinned to a commit SHA that was resolved from the official
  tag before pinning.
- The eval runner executes agent tasks in throwaway workspaces with a safety-net PreToolUse hook;
  `scaffold_script` runs only for suites you authored and opted into. Details:
  [docs/security.md](docs/security.md).
- Nothing is sent to any service of ours; there is no service of ours.

## Supported versions

The latest release line receives fixes. The `v0`/`v1` moving tag always points at it.
