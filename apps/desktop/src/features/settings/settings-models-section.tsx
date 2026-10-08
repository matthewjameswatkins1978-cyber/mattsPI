import { useState, type ReactNode } from "react";
import type {
  RuntimeModelRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import { SearchIcon } from "../../ui/icons";
import { SettingsSelect, SettingsSwitch } from "./settings-controls";
import {
  filterModels,
  labelForThinking,
  SettingsGroup,
  SettingsRow,
  THINKING_LEVELS,
} from "./settings-utils";

interface SettingsModelsSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly onSetDefaultModel: (provider: string, modelId: string) => void;
  readonly onSetThinkingLevel: (
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ) => void;
  readonly onSetScopedModelPatterns: (patterns: readonly string[]) => void;
  readonly onOpenProviders: () => void;
}

const THINKING_OPTIONS = THINKING_LEVELS.map((level) => ({
  value: level,
  label: labelForThinking(level),
}));

function modelPattern(model: RuntimeModelRecord): string {
  return `${model.providerId}/${model.modelId}`;
}

/** Cursor's Models page: defaults on top, then one searchable list with a switch per model. */
export function SettingsModelsSection({
  runtime,
  onSetDefaultModel,
  onSetThinkingLevel,
  onSetScopedModelPatterns,
  onOpenProviders,
}: SettingsModelsSectionProps) {
  const [query, setQuery] = useState("");
  const [showUnconnected, setShowUnconnected] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<ReadonlySet<string>>(() => new Set());

  const models = runtime?.models ?? [];
  const availableModels = models.filter((model) => model.available);
  const unconnectedModels = models.filter((model) => !model.available);
  const providerById = new Map(
    (runtime?.providers ?? []).map((provider) => [provider.id, provider]),
  );

  // No saved patterns means pi enables every available model.
  const savedPatterns = runtime?.settings.enabledModelPatterns ?? [];
  const activePatterns =
    savedPatterns.length === 0 ? availableModels.map(modelPattern) : savedPatterns;
  const activeSet = new Set(activePatterns);
  const enabledModels = availableModels.filter((model) => activeSet.has(modelPattern(model)));

  const defaultProvider = runtime?.settings.defaultProvider;
  const defaultModelId = runtime?.settings.defaultModelId;
  const defaultValue =
    defaultProvider && defaultModelId ? `${defaultProvider}:${defaultModelId}` : undefined;
  const defaultIsEnabled = enabledModels.some(
    (model) => model.providerId === defaultProvider && model.modelId === defaultModelId,
  );

  const searching = query.trim().length > 0;
  const visibleAvailable = filterModels(availableModels, query);
  const visibleUnconnected = filterModels(unconnectedModels, query);

  const groupModels = (items: readonly RuntimeModelRecord[]) => {
    const groups = new Map<string, RuntimeModelRecord[]>();
    for (const model of items) {
      const group = groups.get(model.providerId) ?? [];
      group.push(model);
      groups.set(model.providerId, group);
    }
    return [...groups.entries()]
      .map(([providerId, groupModels]) => {
        const provider = providerById.get(providerId);
        return {
          providerId,
          name: provider?.name ?? groupModels[0]?.providerName ?? providerId,
          connected: provider?.hasAuth ?? groupModels.some((model) => model.available),
          models: groupModels,
        };
      })
      .sort(
        (left, right) =>
          Number(right.connected) - Number(left.connected) || left.name.localeCompare(right.name),
      );
  };

  const setEnabled = (pattern: string, enabled: boolean) => {
    const next = enabled
      ? [...new Set([...activePatterns, pattern])]
      : activePatterns.filter((entry) => entry !== pattern);
    if (next.length > 0) onSetScopedModelPatterns(next);
  };

  const setProviderEnabled = (providerModels: readonly RuntimeModelRecord[], enabled: boolean) => {
    const providerPatterns = new Set(providerModels.map(modelPattern));
    const next = enabled
      ? [...new Set([...activePatterns, ...providerPatterns])]
      : activePatterns.filter((pattern) => !providerPatterns.has(pattern));
    // Persisting [] means "all available" to Pi, so never use it to mean "none".
    if (next.length > 0) onSetScopedModelPatterns(next);
  };

  const toggleProvider = (providerId: string) => {
    setExpandedProviders((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };

  const renderProviderGroups = (
    items: readonly RuntimeModelRecord[],
    options: { readonly controls: boolean; readonly listId: string },
  ) =>
    groupModels(items).map((group) => {
      const patterns = group.models.map(modelPattern);
      const enabledCount = patterns.filter((pattern) => activeSet.has(pattern)).length;
      const selection =
        enabledCount === 0 ? "none" : enabledCount === patterns.length ? "all" : "some";
      const expanded = searching || expandedProviders.has(group.providerId);
      const panelId = `${options.listId}-${group.providerId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      const enabledOutsideGroup = activePatterns.some((pattern) => !patterns.includes(pattern));

      return (
        <div
          className="settings-provider-group"
          data-provider-id={group.providerId}
          data-selection={selection}
          key={group.providerId}
        >
          <div className="settings-provider-group__header">
            <button
              aria-controls={panelId}
              aria-expanded={expanded}
              className="settings-provider-group__toggle"
              onClick={() => toggleProvider(group.providerId)}
              type="button"
            >
              <span aria-hidden="true" className="settings-provider-group__chevron">
                {expanded ? "▾" : "▸"}
              </span>
              <span className="settings-provider-group__identity">
                <span className="settings-provider-group__name">{group.name}</span>
                <span className="settings-provider-group__meta">
                  {group.connected ? "Connected" : "Not connected"} · {enabledCount} of{" "}
                  {group.models.length} enabled
                </span>
              </span>
              <span aria-label={`${selection} selected`} className="settings-provider-group__state">
                {selection === "all" ? "All" : selection === "some" ? "Some" : "None"}
              </span>
            </button>
            {options.controls ? (
              <div className="settings-provider-group__actions">
                <button
                  className="button button--secondary"
                  disabled={enabledCount === group.models.length}
                  onClick={() => setProviderEnabled(group.models, true)}
                  type="button"
                >
                  Enable all
                </button>
                <button
                  className="button button--secondary"
                  disabled={enabledCount === 0 || !enabledOutsideGroup}
                  onClick={() => setProviderEnabled(group.models, false)}
                  type="button"
                >
                  Disable all
                </button>
              </div>
            ) : null}
          </div>
          {expanded ? (
            <div className="settings-provider-group__models" id={panelId}>
              {group.models.map((model) => {
                const pattern = modelPattern(model);
                const enabled = activeSet.has(pattern);
                return (
                  <ModelRow
                    isDefault={
                      model.providerId === defaultProvider && model.modelId === defaultModelId
                    }
                    key={pattern}
                    model={model}
                  >
                    {options.controls ? (
                      <SettingsSwitch
                        checked={enabled}
                        disabled={enabled && !activePatterns.some((entry) => entry !== pattern)}
                        label={`Enable ${pattern}`}
                        onChange={(next) => setEnabled(pattern, next)}
                      />
                    ) : null}
                  </ModelRow>
                );
              })}
            </div>
          ) : null}
        </div>
      );
    });

  return (
    <>
      <SettingsGroup>
        <SettingsRow title="Default model" description="Used for new threads.">
          <SettingsSelect
            label="Default model"
            options={enabledModels.map((model) => ({
              value: `${model.providerId}:${model.modelId}`,
              label: `${model.providerName} · ${model.label}`,
            }))}
            value={defaultIsEnabled ? defaultValue : undefined}
            onChange={(value) => {
              const [provider = "", ...modelParts] = value.split(":");
              onSetDefaultModel(provider, modelParts.join(":"));
            }}
          />
        </SettingsRow>
        <SettingsRow title="Reasoning" description="Default reasoning effort for new threads.">
          <SettingsSelect
            label="Reasoning"
            options={THINKING_OPTIONS}
            value={runtime?.settings.defaultThinkingLevel ?? undefined}
            onChange={onSetThinkingLevel}
          />
        </SettingsRow>
        {defaultValue && !defaultIsEnabled ? (
          <div className="settings-row">
            <span className="settings-warning">
              Your default model ({defaultProvider}/{defaultModelId}) is turned off or its provider
              is not connected. Choose a new default.
            </span>
          </div>
        ) : null}
      </SettingsGroup>

      <section className="settings-section">
        <div className="settings-section__header">
          <h3 className="settings-section__title">
            Enabled models{" "}
            <span className="resource-list__count">
              {enabledModels.length} of {availableModels.length}
            </span>
          </h3>
          <label className="resource-search">
            <SearchIcon />
            <input
              aria-label="Search models"
              placeholder="Search models"
              spellCheck={false}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        </div>
        <p className="settings-section__description">
          Only enabled models appear in model pickers.
        </p>
        <div className="settings-group" data-testid="settings-model-list">
          {visibleAvailable.length === 0 ? (
            <div className="settings-row">
              <span className="settings-row__description">
                {availableModels.length === 0
                  ? "No connected models available yet. Connect a provider to add models."
                  : `No connected models match “${query.trim()}”.`}
              </span>
            </div>
          ) : (
            renderProviderGroups(visibleAvailable, { controls: true, listId: "enabled-models" })
          )}
        </div>
      </section>

      {unconnectedModels.length > 0 && (!searching || visibleUnconnected.length > 0) ? (
        <section className="settings-section">
          <div className="settings-section__header">
            <h3 className="settings-section__title">
              Not connected{" "}
              <span className="resource-list__count">{visibleUnconnected.length}</span>
            </h3>
            <button className="button button--secondary" type="button" onClick={onOpenProviders}>
              Connect a provider
            </button>
          </div>
          <p className="settings-section__description">
            Models from providers you have not signed in to.
          </p>
          {searching || showUnconnected ? (
            <div className="settings-group" data-testid="settings-unconnected-model-list">
              {renderProviderGroups(visibleUnconnected, {
                controls: false,
                listId: "unconnected-models",
              })}
            </div>
          ) : (
            <button
              className="resource-list__more"
              type="button"
              onClick={() => setShowUnconnected(true)}
            >
              Show {unconnectedModels.length} models
            </button>
          )}
        </section>
      ) : null}
    </>
  );
}

function ModelRow({
  model,
  isDefault,
  children,
}: {
  readonly model: RuntimeModelRecord;
  readonly isDefault: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="settings-row model-row">
      <div className="settings-row__label">
        <div className="settings-row__title">
          {model.label}
          {isDefault ? <span className="model-row__badge">Default</span> : null}
        </div>
        <div className="settings-row__description">
          {model.providerName} · {modelPattern(model)}
          {model.reasoning ? <span className="model-row__tag">Reasoning</span> : null}
          {model.supportsImages ? <span className="model-row__tag">Images</span> : null}
        </div>
      </div>
      {children ? <div className="settings-row__control">{children}</div> : null}
    </div>
  );
}
