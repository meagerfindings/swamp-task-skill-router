import {
  composePrompt,
  model,
  selectSkills,
  type SkillRule,
} from "./task_skill_router.ts";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";

const STAGES = [
  "planning",
  "plan-review",
  "implementing",
  "increment-review",
  "final-review",
] as const;

const rules: SkillRule[] = [
  {
    skill: "view-rendering",
    priority: 100,
    stages: [...STAGES],
    pathPrefixes: ["app/views/"],
    pathSuffixes: [".html.erb"],
  },
  {
    skill: "controller-patterns",
    priority: 100,
    stages: [...STAGES],
    pathPrefixes: ["app/controllers/"],
    pathSuffixes: [],
  },
  {
    skill: "system-testing",
    priority: 200,
    stages: [...STAGES],
    pathPrefixes: ["spec/system/"],
    pathSuffixes: [],
  },
  {
    skill: "integration-testing",
    priority: 200,
    stages: [...STAGES],
    pathPrefixes: ["spec/requests/"],
    pathSuffixes: [],
  },
];

const contents = {
  "view-rendering": "view guidance",
  "controller-patterns": "controller guidance",
  "system-testing": "system guidance",
  "integration-testing": "request guidance",
};

const globalArgs = {
  skillRoot: ".agents/skills",
  selectionVersion: "test-1",
  maxSkills: 2,
  maxSkillChars: 1_000,
  rules,
};

async function writeSkill(
  repoDir: string,
  name: keyof typeof contents,
): Promise<void> {
  const directory = `${repoDir}/.agents/skills/${name}`;
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(`${directory}/SKILL.md`, contents[name]);
}

Deno.test("routes deterministically by path and stage", () => {
  const selected = selectSkills(
    rules,
    "implementing",
    ["spec/system/widget_spec.rb", "app/views/widgets/show.html.erb"],
    contents,
    2,
    1_000,
  );
  assertEquals(
    selected.selectedSkills.map((skill) => skill.name),
    ["view-rendering", "system-testing"],
  );

  const testing = selectSkills(
    rules,
    "testing",
    ["app/views/widgets/show.html.erb"],
    contents,
    2,
    1_000,
  );
  assertEquals(testing.selectedSkills, []);
  assertEquals(testing.rejectedSkills[0].reason, "not enabled for testing");
});

Deno.test("ordering and path deduplication are stable", () => {
  const paths = [
    "spec/requests/widgets_spec.rb",
    "app/controllers/widgets_controller.rb",
    "app/controllers/widgets_controller.rb",
  ];
  const forward = selectSkills(
    rules,
    "planning",
    paths,
    contents,
    4,
    1_000,
  );
  const reverse = selectSkills(
    rules,
    "planning",
    [...paths].reverse(),
    contents,
    4,
    1_000,
  );
  assertEquals(forward, reverse);
  assertEquals(
    forward.selectedSkills.map((skill) => skill.name),
    ["controller-patterns", "integration-testing"],
  );
});

Deno.test("count and character budgets reject candidates with evidence", () => {
  const countLimited = selectSkills(
    rules,
    "implementing",
    ["app/views/widgets/show.html.erb", "spec/system/widget_spec.rb"],
    contents,
    1,
    1_000,
  );
  assertEquals(countLimited.selectedSkills[0].name, "view-rendering");
  assertEquals(
    countLimited.rejectedSkills.find((skill) => skill.name === "system-testing")
      ?.reason,
    "maxSkills budget reached",
  );

  const charLimited = selectSkills(
    rules,
    "implementing",
    ["app/views/widgets/show.html.erb", "spec/system/widget_spec.rb"],
    contents,
    2,
    contents["view-rendering"].length,
  );
  assertEquals(charLimited.skillChars, contents["view-rendering"].length);
  assertEquals(
    charLimited.rejectedSkills.find((skill) => skill.name === "system-testing")
      ?.reason,
    "maxSkillChars budget would be exceeded (15 chars)",
  );
});

Deno.test("composes only selected guidance before the bounded task", () => {
  const selection = selectSkills(
    rules,
    "implementing",
    ["app/views/widgets/show.html.erb"],
    contents,
    2,
    1_000,
  );
  const prompt = composePrompt("Make the bounded change.", selection, contents);
  assertStringIncludes(prompt, '<factory-skill name="view-rendering"');
  assertStringIncludes(prompt, "view guidance");
  assertStringIncludes(prompt, "<factory-task>\nMake the bounded change.");
  assertEquals(prompt.includes("system guidance"), false);
});

Deno.test("route writes prompt and selection resources with deterministic evidence", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    await writeSkill(repoDir, "view-rendering");
    await writeSkill(repoDir, "system-testing");
    const { context, getWrittenResources, getLogsByLevel } =
      createModelTestContext({ repoDir, methodName: "route", globalArgs });

    await model.methods.route.execute(
      {
        packetId: "packet-1",
        routingId: "packet-1-agent-1",
        stage: "implementing",
        prompt: "Add bounded guidance.",
        allowedPaths: [
          "app/views/widgets/show.html.erb",
          "spec/system/widget_spec.rb",
        ],
        provider: "example-agent",
      },
      context,
    );

    const resources = getWrittenResources();
    assertEquals(
      resources.map(({ specName, name }) => ({ specName, name })),
      [
        { specName: "prompt", name: "skill-prompt-packet-1-agent-1" },
        { specName: "selection", name: "skill-selection-packet-1-agent-1" },
      ],
    );
    assertEquals(
      (resources[1].data.selectedSkills as Array<{ name: string }>).map((
        skill,
      ) => skill.name),
      ["view-rendering", "system-testing"],
    );
    assertEquals(resources[1].data.appliedBudget, {
      maxSkills: 2,
      maxSkillChars: 1_000,
    });
    assertStringIncludes(
      resources[0].data.composedPrompt as string,
      "<factory-task>\nAdd bounded guidance.",
    );
    assertEquals((resources[1].data.inputHash as string).length, 64);
    assertEquals((resources[1].data.rulesHash as string).length, 64);
    assertEquals((resources[1].data.skillContentHash as string).length, 64);
    assertEquals(getLogsByLevel("info").length, 2);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("route fails before writing when a matched skill is unavailable", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoDir}/.agents/skills`, { recursive: true });
    const { context, getWrittenResources } = createModelTestContext({
      repoDir,
      methodName: "route",
      globalArgs,
    });
    await assertRejects(
      () =>
        model.methods.route.execute(
          {
            packetId: "missing-skill",
            routingId: "missing-skill-agent-1",
            stage: "implementing",
            prompt: "Use view guidance.",
            allowedPaths: ["app/views/widgets/index.html.erb"],
            provider: "example-agent",
          },
          context,
        ),
      Error,
      "configured skill is unavailable: view-rendering",
    );
    assertEquals(getWrittenResources(), []);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("route rejects traversal and absolute paths", () => {
  for (const path of ["/tmp/file.rb", "app/../secrets.txt"]) {
    const result = model.methods.route.arguments.safeParse({
      packetId: "invalid-path",
      routingId: "invalid-path-agent-1",
      stage: "implementing",
      prompt: "Do not run.",
      allowedPaths: [path],
      provider: "example-agent",
    });
    assertEquals(result.success, false);
  }
});

Deno.test("explicit overrides are distinct from global budget names and win", async () => {
  const base = {
    packetId: "budget-schema",
    routingId: "budget-schema-agent-1",
    stage: "implementing" as const,
    prompt: "Use one skill.",
    allowedPaths: [
      "app/views/widgets/index.html.erb",
      "spec/system/widget_spec.rb",
    ],
    provider: "example-agent",
  };
  assertEquals(
    model.methods.route.arguments.parse({ ...base, maxSkills: 1 })
      .overrideMaxSkills,
    undefined,
  );

  const repoDir = await Deno.makeTempDir();
  try {
    await writeSkill(repoDir, "view-rendering");
    await writeSkill(repoDir, "system-testing");
    const { context, getWrittenResources } = createModelTestContext({
      repoDir,
      methodName: "route",
      globalArgs,
    });
    await model.methods.route.execute(
      { ...base, overrideMaxSkills: 1, overrideMaxSkillChars: 100 },
      context,
    );
    assertEquals(getWrittenResources()[1].data.appliedBudget, {
      maxSkills: 1,
      maxSkillChars: 100,
    });
    assertEquals(
      (getWrittenResources()[1].data.selectedSkills as Array<{ name: string }>)
        .map((skill) => skill.name),
      ["view-rendering"],
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});
