# Security policy

Please report vulnerabilities privately through GitHub's "Report a
vulnerability" form on this repository, not in public issues.

Areas that matter most:

- Requests reaching hosts outside a plugin's `hosts` list
- Secrets becoming visible to expressions other than `auth`
- Expressions that evaluate unbounded work
- Host port contracts that make unsafe behaviour easy (redirects, missing
  timeouts or body limits)

Supported versions: the latest `0.x` release.
