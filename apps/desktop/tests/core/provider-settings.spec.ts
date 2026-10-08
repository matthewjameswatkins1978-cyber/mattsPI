import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  stubNextOpenDialog,
} from "../helpers/electron-app";

/** 0.85.1 Settings rows use the catalog display name, not the provider id. */
const OPENAI_CATALOG_TITLE = /^OpenAI$/;

test("settings lets the user save an API key for a built-in provider", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-api-key-workspace");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["openai/gpt-5", "openai/gpt-4o"],
  });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Providers");

    const availableProviders = window.getByTestId("settings-available-providers");
    await window.getByLabel("Search providers").fill("openai");
    const openAiRow = availableProviders.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: OPENAI_CATALOG_TITLE }),
    });
    await expect(openAiRow).toContainText("API key");
    await openAiRow.getByRole("button", { name: "Set API key" }).click();

    const dialog = window.getByTestId("provider-api-key-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("OpenAI API key").fill("test-openai-key");
    await dialog.getByRole("button", { name: "Set API key" }).click();
    await expect(dialog).toHaveCount(0);

    const connectedProviders = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Connected" }),
    });
    await expect(connectedProviders).toContainText("OpenAI");
    await expect(connectedProviders).toContainText("API key");
    await expect(connectedProviders.getByRole("button", { name: "Manage" })).toBeVisible();

    await window.getByRole("button", { name: "Models", exact: true }).click();
    const enabledModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Enabled models" }),
    });
    const openAiGroup = enabledModels.locator('[data-provider-id="openai"]');
    await expect(openAiGroup).toContainText("Connected");
    await openAiGroup.getByRole("button", { name: /OpenAI/ }).click();
    await expect(
      enabledModels.getByRole("switch", { name: "Enable openai/gpt-5", exact: true }),
    ).toBeChecked();
    await expect(
      enabledModels.getByRole("switch", { name: "Enable openai/gpt-4o", exact: true }),
    ).toBeChecked();
  } finally {
    await harness.close();
  }
});

test("model groups preserve gateway routes, bulk selections, and the saved shortlist", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-groups-workspace");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["mimo-account/claude-sonnet-4", "openai/gpt-5", "deepseek/deepseek-chat"],
  });
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "mimo-account": {
            baseUrl: "https://gateway.example.test/v1",
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [
              { id: "claude-sonnet-4", name: "Claude Sonnet via MiMo" },
              { id: "claude-haiku-4", name: "Claude Haiku via MiMo" },
            ],
          },
          deepseek: {
            baseUrl: "https://deepseek.example.test/v1",
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [{ id: "deepseek-chat" }],
          },
          openai: {
            baseUrl: "https://openai.example.test/v1",
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [{ id: "gpt-5" }],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });
  let harness = await launch();
  try {
    let window = await harness.firstWindow();
    await createNamedThread(window, "Provider grouping shortlist test");
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Models", exact: true }).click();

    const models = window.getByTestId("settings-model-list");
    const gateway = models.locator('[data-provider-id="mimo-account"]');
    const deepSeek = models.locator('[data-provider-id="deepseek"]');
    await expect(gateway).toHaveAttribute("data-selection", "some");
    await expect(gateway).toContainText("Connected");
    await expect(gateway).toContainText("1 of 2 enabled");
    await expect(deepSeek).toHaveAttribute("data-selection", "some");
    await expect(models.locator("[data-provider-id]").first()).toHaveAttribute(
      "data-provider-id",
      "deepseek",
    );

    const gatewayToggle = gateway.getByRole("button", { name: /mimo-account/ });
    await expect(gatewayToggle).toHaveAttribute("aria-expanded", "false");
    await gatewayToggle.click();
    await expect(
      gateway.getByRole("switch", {
        name: "Enable mimo-account/claude-sonnet-4",
        exact: true,
      }),
    ).toBeChecked();
    await expect(
      gateway.getByRole("switch", {
        name: "Enable mimo-account/claude-haiku-4",
        exact: true,
      }),
    ).not.toBeChecked();

    await gateway.getByRole("button", { name: "Enable all", exact: true }).click();
    await expect(gateway).toHaveAttribute("data-selection", "all");
    const haikuSwitch = gateway.getByRole("switch", {
      name: "Enable mimo-account/claude-haiku-4",
      exact: true,
    });
    await expect(haikuSwitch).toBeChecked();
    await haikuSwitch.click();
    await expect(gateway).toHaveAttribute("data-selection", "some");

    await gateway.getByRole("button", { name: "Disable all", exact: true }).click();
    await expect(gateway).toHaveAttribute("data-selection", "none");
    await expect(deepSeek).toHaveAttribute("data-selection", "some");
    await deepSeek.getByRole("button", { name: /deepseek/i }).click();
    await expect(
      models.getByRole("switch", { name: "Enable deepseek/deepseek-chat", exact: true }),
    ).toBeChecked();

    await window.getByLabel("Search models").fill("Claude Sonnet via MiMo");
    await expect(gateway).toBeVisible();
    await expect(gateway.getByRole("button", { name: /mimo-account/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(
      gateway.getByRole("switch", {
        name: "Enable mimo-account/claude-sonnet-4",
        exact: true,
      }),
    ).toBeVisible();
    await window.getByLabel("Search models").fill("");

    if (process.env.PI_APP_PROVIDER_GROUPS_PROOF_DIR) {
      await mkdir(process.env.PI_APP_PROVIDER_GROUPS_PROOF_DIR, { recursive: true });
      await window.screenshot({
        path: join(process.env.PI_APP_PROVIDER_GROUPS_PROOF_DIR, "provider-groups-after.png"),
        fullPage: true,
      });
    }

    await harness.close();
    harness = await launch();
    window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await window.getByRole("button", { name: "Models", exact: true }).click();
    const restored = window.getByTestId("settings-model-list");
    await expect(restored.locator('[data-provider-id="mimo-account"]')).toHaveAttribute(
      "data-selection",
      "none",
    );
    const restoredDeepSeek = restored.locator('[data-provider-id="deepseek"]');
    await expect(restoredDeepSeek).toHaveAttribute("data-selection", "some");
    await restoredDeepSeek.getByRole("button", { name: /deepseek/i }).click();
    await expect(
      restoredDeepSeek.getByRole("switch", {
        name: "Enable deepseek/deepseek-chat",
        exact: true,
      }),
    ).toBeChecked();

    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    const modelBadge = window.locator(".composer__bar .model-selector__badge").first();
    await expect(modelBadge).toBeVisible();
    await modelBadge.click();
    const picker = window.locator(".composer__bar .model-selector__dropdown").first();
    await expect(picker).toBeVisible();
    await expect(picker).toContainText("deepseek-chat");
    await expect(picker).toContainText("gpt-5");
    await expect(picker).not.toContainText("claude-sonnet-4");
  } finally {
    await harness.close();
  }
});

test("provider bulk disable cannot turn an empty all-enabled list into none or all", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-empty-patterns-workspace");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: [],
  });
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "review-gateway": {
            baseUrl: "https://gateway.example.test/v1",
            api: "openai-completions",
            apiKey: "fixture-key",
            models: [{ id: "model-one" }, { id: "model-two" }],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await window.getByRole("button", { name: "Models", exact: true }).click();
    const group = window
      .getByTestId("settings-model-list")
      .locator('[data-provider-id="review-gateway"]');
    await expect(group).toHaveAttribute("data-selection", "all");
    await expect(group.getByRole("button", { name: "Disable all", exact: true })).toBeDisabled();
    await group.getByRole("button", { name: /review-gateway/i }).click();
    if (process.env.PI_APP_PROVIDER_GROUPS_PROOF_DIR) {
      await mkdir(process.env.PI_APP_PROVIDER_GROUPS_PROOF_DIR, { recursive: true });
      await window.screenshot({
        path: join(process.env.PI_APP_PROVIDER_GROUPS_PROOF_DIR, "provider-groups-after.png"),
        fullPage: true,
      });
    }
  } finally {
    await harness.close();
  }
});

test("settings shows environment-configured providers as managed externally", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-env-workspace");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["openai/gpt-5"],
  });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: { OPENAI_API_KEY: "test-openai-env-key" },
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Providers");

    const connectedProviders = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Connected" }),
    });
    const openAiRow = connectedProviders.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: OPENAI_CATALOG_TITLE }),
    });
    await expect(openAiRow).toContainText("Environment variable");
    await expect(openAiRow.locator(".settings-row__control")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("settings keeps models.json provider overrides in the external-config state", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-models-json-workspace");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["openai/gpt-5"],
  });
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          openai: {
            apiKey: "test-openai-models-json-key",
            baseUrl: "https://api.openai.com/v1",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Providers");

    const connectedProviders = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Connected" }),
    });
    const openAiRow = connectedProviders.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: OPENAI_CATALOG_TITLE }),
    });
    await expect(openAiRow).toContainText("Configured externally");
    await expect(openAiRow.locator(".settings-row__control")).toHaveCount(0);

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    await expect(customEndpoints).toContainText("No custom endpoints yet.");
    await expect(
      customEndpoints.locator(".settings-row", {
        has: window.locator(".settings-row__title", { hasText: /^openai$/ }),
      }),
    ).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("opening the first workspace from the empty state hydrates provider and model settings without refresh", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-first-workspace");
  await seedAgentDir(agentDir, {
    enabledModels: ["openai/gpt-5", "openai/gpt-4o"],
  });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const emptyState = window.getByTestId("empty-state");
    await expect(emptyState).toBeVisible();

    await stubNextOpenDialog(harness, [workspacePath]);
    await emptyState.getByRole("button", { name: "Open first folder" }).click();

    await expect(emptyState).toHaveCount(0);
    await expect(window.getByTestId("workspace-list")).toContainText(
      "provider-settings-first-workspace",
    );
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();

    await window.keyboard.press(desktopShortcut(","));
    const settingsSurface = window.getByTestId("settings-surface");
    await expect(settingsSurface).toBeVisible();
    await expect(settingsSurface.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(
      0,
    );

    await window.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Providers");

    const connectedProviders = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Connected" }),
    });
    await expect(connectedProviders).toContainText("OpenAI");
    await expect(connectedProviders).toContainText("API key");

    await window.getByRole("button", { name: "Models", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Models");

    const enabledModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Enabled models" }),
    });
    await enabledModels
      .locator('[data-provider-id="openai"]')
      .getByRole("button", { name: /openai/i })
      .click();
    await expect(
      enabledModels.getByRole("switch", { name: "Enable openai/gpt-5", exact: true }),
    ).toBeChecked();
    await expect(
      enabledModels.getByRole("switch", { name: "Enable openai/gpt-4o", exact: true }),
    ).toBeChecked();
  } finally {
    await harness.close();
  }
});

test("providers flags the default model's provider when it is not connected", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-attention-workspace");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Models", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Models");
    const unconnected = window.getByTestId("settings-unconnected-model-list");
    await expect(unconnected).toHaveCount(0);
    await window.getByLabel("Search models").fill("gpt-4o");
    await expect(
      unconnected.locator(".model-row", { hasText: "openai/gpt-4o" }).first(),
    ).toBeVisible();
    await expect(unconnected.getByRole("switch")).toHaveCount(0);

    await window.getByRole("button", { name: "Connect a provider" }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Providers");
    const available = window.getByTestId("settings-available-providers");
    await expect(available.locator(".settings-row")).toHaveCount(8);
    await expect(available.locator(".settings-row").first()).toContainText("OAuth");
    await window.getByRole("button", { name: /^Show \d+ more$/ }).click();
    await expect.poll(() => available.locator(".settings-row").count()).toBeGreaterThan(8);

    const attention = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Needs attention" }),
    });
    await expect(
      attention.locator(".settings-row__title", { hasText: OPENAI_CATALOG_TITLE }),
    ).toHaveCount(1);
    await window.getByLabel("Search providers").fill("openai");
    await expect(
      window
        .getByTestId("settings-available-providers")
        .locator(".settings-row__title", { hasText: new RegExp(`^${OPENAI_CATALOG_TITLE}$`) }),
    ).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
