# @mgreten/task-skill-router

`task-skill-router` deterministically chooses repository-local agent skills from configurable stage and path rules, applies strict count and character budgets, and composes the selected guidance with a task prompt. It records both selections and rejections with content and input hashes, making routing reproducible and auditable without a model call.

## Installation

```sh
swamp extension pull @mgreten/task-skill-router
```

## Setup

Create an instance with rules suited to your repository. Skill names resolve to `<skillRoot>/<name>/SKILL.md`.

```sh
swamp model create skill-router \
  --type @mgreten/task-skill-router \
  --global-arg selectionVersion=v1 \
  --global-arg maxSkills=2 \
  --global-arg maxSkillChars=40000 \
  --global-arg 'rules=[{"skill":"rails-testing","priority":10,"stages":["testing"],"pathPrefixes":["spec/"],"pathSuffixes":[]}]'
```

## Usage

Route a task by supplying stable packet and routing identifiers, a lifecycle stage, the task prompt, repository-relative paths, and a provider label for audit metadata:

```sh
swamp model method run skill-router route \
  --input packetId=packet-42 \
  --input routingId=route-42 \
  --input stage=testing \
  --input prompt="Add request coverage for the session endpoint" \
  --input 'allowedPaths=["spec/requests/sessions_spec.rb"]' \
  --input provider=agent
```

The method writes a `prompt` resource containing the composed prompt and a `selection` resource containing selected/rejected skills, applied budget, and SHA-256 evidence.

## Global Arguments

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `skillRoot` | string | `.agents/skills` | Repository-relative or absolute root containing skill directories. |
| `selectionVersion` | string | required | Caller-controlled version for the routing configuration. |
| `maxSkills` | integer, 0–8 | `2` | Maximum selected skills. |
| `maxSkillChars` | integer, 0–100000 | `40000` | Maximum total characters across selected skills. |
| `rules` | array | required | Skill, priority, stages, path prefixes, and path suffixes. |

## Method: route

| Argument | Type | Required | Description |
| --- | --- | --- | --- |
| `packetId` | string | yes | Stable task packet identifier. |
| `routingId` | string | yes | Stable identifier used in output resource names. |
| `stage` | enum | yes | Intake, planning, review, implementation, or testing stage. |
| `prompt` | string | yes | Original task prompt. |
| `allowedPaths` | string[] | yes | Repository-relative paths used for deterministic matching. |
| `provider` | string | yes | Audit label included in hashes and selection output. |
| `overrideMaxSkills` | integer | no | Per-call skill-count limit. |
| `overrideMaxSkillChars` | integer | no | Per-call character limit. |

## How It Works

Rules are grouped by skill, filtered by stage, and matched against normalized allowed paths. Candidates sort by numeric priority and then skill name. The router reads only configured `SKILL.md` files, rejects candidates that exceed either budget, composes XML-delimited guidance, and stores short-lived prompt and selection resources. It requires no network service or model API, but the configured skill files must exist and be readable.

## License

MIT — see LICENSE.txt for details.
