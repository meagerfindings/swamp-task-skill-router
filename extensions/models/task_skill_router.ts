/**
 * Deterministic, model-free skill selection and bounded prompt composition.
 *
 * @module task_skill_router
 */
// deno-lint-ignore-file no-explicit-any
import { z } from "npm:zod@4.0.17";

const StageSchema = z.enum([
  "intake",
  "planning",
  "plan-review",
  "implementing",
  "increment-review",
  "testing",
  "final-review",
]);

const SkillNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const RepoPathSchema = z.string().min(1).refine(
  (path) => !path.startsWith("/") && !path.split("/").includes(".."),
  "must be a repository-relative path without parent traversal",
);
const PacketIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);

const RuleSchema = z.object({
  skill: SkillNameSchema,
  priority: z.number().int().min(0).max(1000),
  stages: z.array(StageSchema).min(1),
  pathPrefixes: z.array(z.string().min(1)).default([]),
  pathSuffixes: z.array(z.string().min(1)).default([]),
});

const BudgetSchema = z.object({
  maxSkills: z.number().int().min(0).max(8),
  maxSkillChars: z.number().int().min(0).max(100_000),
});

const GlobalArgsSchema = z.object({
  skillRoot: z.string().min(1).default(".agents/skills"),
  selectionVersion: z.string().min(1),
  maxSkills: z.number().int().min(0).max(8).default(2),
  maxSkillChars: z.number().int().min(0).max(100_000).default(40_000),
  rules: z.array(RuleSchema).min(1),
});

const RouteArgsSchema = z.object({
  packetId: PacketIdSchema,
  routingId: PacketIdSchema,
  stage: StageSchema,
  prompt: z.string().min(1).max(60_000),
  allowedPaths: z.array(RepoPathSchema).min(1),
  provider: z.string().min(1),
  overrideMaxSkills: z.number().int().min(0).max(8).optional(),
  overrideMaxSkillChars: z.number().int().min(0).max(100_000).optional(),
});

const SelectedSkillSchema = z.object({
  name: SkillNameSchema,
  reason: z.string(),
  contentChars: z.number().int().nonnegative(),
});

const RejectedSkillSchema = z.object({
  name: SkillNameSchema,
  reason: z.string(),
});

const SelectionSchema = z.object({
  packetId: PacketIdSchema,
  routingId: PacketIdSchema,
  stage: StageSchema,
  provider: z.string(),
  selectionVersion: z.string(),
  rulesHash: z.string().length(64),
  skillContentHash: z.string().length(64),
  inputHash: z.string().length(64),
  appliedBudget: BudgetSchema,
  selectedSkills: z.array(SelectedSkillSchema),
  rejectedSkills: z.array(RejectedSkillSchema),
  skillChars: z.number().int().nonnegative(),
  promptResourceName: z.string(),
  selectedAt: z.string(),
});

const PromptSchema = z.object({
  packetId: PacketIdSchema,
  routingId: PacketIdSchema,
  inputHash: z.string().length(64),
  composedPrompt: z.string().max(160_000),
  composedPromptChars: z.number().int().nonnegative(),
  createdAt: z.string(),
});

/** A configured skill routing rule. */
export type SkillRule = z.infer<typeof RuleSchema>;

/** Validated input for a route operation. */
export type RouteInput = z.infer<typeof RouteArgsSchema>;

type SkillCandidate = {
  name: string;
  priority: number;
  reason: string;
};

/** The deterministic result of applying routing rules and prompt budgets. */
export type SkillSelection = {
  selectedSkills: Array<{ name: string; reason: string; contentChars: number }>;
  rejectedSkills: Array<{ name: string; reason: string }>;
  skillChars: number;
};

function matchesPath(rule: SkillRule, path: string): boolean {
  return rule.pathPrefixes.some((prefix) => path.startsWith(prefix)) ||
    rule.pathSuffixes.some((suffix) => path.endsWith(suffix));
}

function candidateSkills(
  rules: SkillRule[],
  stage: z.infer<typeof StageSchema>,
  allowedPaths: string[],
): {
  candidates: SkillCandidate[];
  rejected: SkillSelection["rejectedSkills"];
} {
  const grouped = new Map<string, SkillRule[]>();
  for (const rule of rules) {
    grouped.set(rule.skill, [...(grouped.get(rule.skill) ?? []), rule]);
  }

  const candidates: SkillCandidate[] = [];
  const rejected: SkillSelection["rejectedSkills"] = [];
  for (const [name, skillRules] of grouped) {
    const stageRules = skillRules.filter((rule) => rule.stages.includes(stage));
    if (stageRules.length === 0) {
      rejected.push({ name, reason: `not enabled for ${stage}` });
      continue;
    }

    const matches = stageRules.flatMap((rule) =>
      allowedPaths.filter((path) => matchesPath(rule, path)).map((path) => ({
        path,
        priority: rule.priority,
      }))
    );
    if (matches.length === 0) {
      rejected.push({ name, reason: "no allowed path matched its rules" });
      continue;
    }

    matches.sort((left, right) =>
      left.priority - right.priority || left.path.localeCompare(right.path)
    );
    candidates.push({
      name,
      priority: matches[0].priority,
      reason: `matched ${matches[0].path}`,
    });
  }

  candidates.sort((left, right) =>
    left.priority - right.priority || left.name.localeCompare(right.name)
  );
  rejected.sort((left, right) => left.name.localeCompare(right.name));
  return { candidates, rejected };
}

/**
 * Selects skills in stable priority/name order while enforcing count and
 * character budgets.
 */
export function selectSkills(
  rules: SkillRule[],
  stage: z.infer<typeof StageSchema>,
  allowedPaths: string[],
  contents: Record<string, string>,
  maxSkills: number,
  maxSkillChars: number,
): SkillSelection {
  const normalizedPaths = [...new Set(allowedPaths)].sort();
  const { candidates, rejected } = candidateSkills(
    rules,
    stage,
    normalizedPaths,
  );
  const selectedSkills: SkillSelection["selectedSkills"] = [];
  let skillChars = 0;

  for (const candidate of candidates) {
    const content = contents[candidate.name];
    if (content === undefined) {
      throw new Error(`configured skill is missing: ${candidate.name}`);
    }
    if (selectedSkills.length >= maxSkills) {
      rejected.push({
        name: candidate.name,
        reason: "maxSkills budget reached",
      });
      continue;
    }
    if (skillChars + content.length > maxSkillChars) {
      rejected.push({
        name: candidate.name,
        reason:
          `maxSkillChars budget would be exceeded (${content.length} chars)`,
      });
      continue;
    }
    selectedSkills.push({
      name: candidate.name,
      reason: candidate.reason,
      contentChars: content.length,
    });
    skillChars += content.length;
  }

  rejected.sort((left, right) => left.name.localeCompare(right.name));
  return { selectedSkills, rejectedSkills: rejected, skillChars };
}

/** Composes selected skill documents and the task into one bounded prompt. */
export function composePrompt(
  taskPrompt: string,
  selection: SkillSelection,
  contents: Record<string, string>,
): string {
  const header = selection.selectedSkills.length === 0
    ? "The factory selected no task-specific skills. Do not broaden the task to load generic guidance."
    : "The factory deterministically selected the skill guidance below. Follow only these skills; do not load additional skills unless the task cannot proceed without one.";
  const sections = selection.selectedSkills.map((skill) =>
    `<factory-skill name="${skill.name}" reason="${skill.reason}">\n${
      contents[skill.name]
    }\n</factory-skill>`
  );
  return [
    header,
    ...sections,
    `<factory-task>\n${taskPrompt}\n</factory-task>`,
  ].join("\n\n");
}

function frame(values: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = values.map((value) => encoder.encode(value));
  const size = parts.reduce((total, part) => total + 8 + part.length, 0);
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setBigUint64(offset, BigInt(part.length), false);
    offset += 8;
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", frame([value]).slice().buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readSkillContents(
  skillRoot: string,
  names: string[],
): Promise<Record<string, string>> {
  if (names.length === 0) return {};
  let resolvedRoot: string;
  try {
    resolvedRoot = await Deno.realPath(skillRoot);
  } catch {
    throw new Error("configured skill root is unavailable");
  }
  const contents: Record<string, string> = {};
  for (const name of names) {
    let path: string;
    try {
      path = await Deno.realPath(`${resolvedRoot}/${name}/SKILL.md`);
    } catch {
      throw new Error(`configured skill is unavailable: ${name}`);
    }
    if (!path.startsWith(`${resolvedRoot}/`)) {
      throw new Error(`skill resolved outside configured root: ${name}`);
    }
    try {
      contents[name] = await Deno.readTextFile(path);
    } catch {
      throw new Error(`configured skill cannot be read: ${name}`);
    }
  }
  return contents;
}

/**
 * Swamp model definition for deterministic task-to-skill routing and bounded
 * prompt composition.
 */
export const model = {
  type: "@mgreten/task-skill-router",
  version: "2026.07.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    selection: {
      description:
        "Deterministic skill selection, rejection evidence, and composed agent prompt for one task",
      schema: SelectionSchema,
      lifetime: "30d" as const,
      garbageCollection: 25,
    },
    prompt: {
      description:
        "Short-lived bounded agent prompt composed from deterministic skill selection",
      schema: PromptSchema,
      lifetime: "1d" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    route: {
      description:
        "Select task-relevant local skills using configured path/stage rules and compose one bounded agent prompt",
      arguments: RouteArgsSchema,
      execute: async (
        args: RouteInput,
        context: any,
      ): Promise<{ dataHandles: any[] }> => {
        context.logger.info("Selecting skills for {packetId}", {
          packetId: args.packetId,
        });
        const rules = context.globalArgs.rules as SkillRule[];
        const { candidates } = candidateSkills(
          rules,
          args.stage,
          [...new Set(args.allowedPaths)].sort(),
        );
        const names = candidates.map((candidate) => candidate.name);
        const configuredRoot = context.globalArgs.skillRoot as string;
        const skillRoot = configuredRoot.startsWith("/")
          ? configuredRoot
          : `${context.repoDir}/${configuredRoot}`;
        const contents = await readSkillContents(skillRoot, names);
        const maxSkills = args.overrideMaxSkills ??
          context.globalArgs.maxSkills;
        const maxSkillChars = args.overrideMaxSkillChars ??
          context.globalArgs.maxSkillChars;
        const selection = selectSkills(
          rules,
          args.stage,
          args.allowedPaths,
          contents,
          maxSkills,
          maxSkillChars,
        );
        const composedPrompt = composePrompt(args.prompt, selection, contents);
        if (composedPrompt.length > 160_000) {
          throw new Error(
            `composed prompt exceeds the 160000 character hard limit (${composedPrompt.length})`,
          );
        }
        const rulesHash = await sha256(JSON.stringify(rules));
        const skillContentHash = await sha256(JSON.stringify(
          selection.selectedSkills.map((skill) => ({
            name: skill.name,
            content: contents[skill.name],
          })),
        ));
        const normalizedInput = JSON.stringify({
          routingId: args.routingId,
          stage: args.stage,
          prompt: args.prompt,
          allowedPaths: [...new Set(args.allowedPaths)].sort(),
          provider: args.provider,
          maxSkills,
          maxSkillChars,
          selectionVersion: context.globalArgs.selectionVersion,
          rulesHash,
          skillContentHash,
        });
        const inputHash = await sha256(normalizedInput);
        const promptResourceName = `skill-prompt-${args.routingId}`;
        const selectedAt = new Date().toISOString();
        const output = {
          packetId: args.packetId,
          routingId: args.routingId,
          stage: args.stage,
          provider: args.provider,
          selectionVersion: context.globalArgs.selectionVersion,
          rulesHash,
          skillContentHash,
          inputHash,
          appliedBudget: { maxSkills, maxSkillChars },
          ...selection,
          promptResourceName,
          selectedAt,
        };
        const promptHandle = await context.writeResource(
          "prompt",
          promptResourceName,
          {
            packetId: args.packetId,
            routingId: args.routingId,
            inputHash,
            composedPrompt,
            composedPromptChars: composedPrompt.length,
            createdAt: selectedAt,
          },
        );
        const selectionHandle = await context.writeResource(
          "selection",
          `skill-selection-${args.routingId}`,
          output,
        );
        context.logger.info("Selected {count} skills for {packetId}", {
          count: selection.selectedSkills.length,
          packetId: args.packetId,
        });
        return { dataHandles: [promptHandle, selectionHandle] };
      },
    },
  },
};
